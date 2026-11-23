// tabletmode: a virtual Tablet Mode switch for the GPD Pocket 4 (and similar
// convertibles that lack a working hardware switch).
//
//	tabletmode daemon          run the service (needs root; started by systemd)
//	tabletmode on|off|toggle   change the mode (caller needs an active local session)
//	tabletmode status          print "on" or "off"
//
// The daemon creates a virtual input device exposing SW_TABLET_MODE through
// /dev/uinput and receives commands over a unix socket. Only the Go standard
// library is used.
package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	maxCmdLen = 64 // bytes; valid commands are only a few characters long
	maxConns  = 16

	// Layer 1: switching tablet mode ON is only allowed at least this long
	// after the previous change. "off" is never rate limited so the user can
	// always get out.
	minOnInterval = 3 * time.Second

	sessionsDir = "/run/systemd/sessions"

	sockPath = "/run/tabletmode/tabletmode.sock"
	devName  = "GPD Pocket 4 Tablet Mode Switch (virtual)"

	evSyn        = 0x00
	evSw         = 0x05
	swTabletMode = 0x01

	uiDevCreate  = 0x5501
	uiDevDestroy = 0x5502
	uiDevSetup   = 0x405c5503
	uiSetEvbit   = 0x40045564
	uiSetSwbit   = 0x4004556d
)

type inputID struct {
	Bustype, Vendor, Product, Version uint16
}

type uinputSetup struct {
	ID           inputID
	Name         [80]byte
	FFEffectsMax uint32
}

type inputEvent struct {
	Sec, Usec int64
	Type      uint16
	Code      uint16
	Value     int32
}

func ioctl(fd, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); e != 0 {
		return e
	}
	return nil
}

type device struct {
	mu         sync.Mutex
	f          *os.File
	state      bool
	lastChange time.Time
}

func newDevice() (*device, error) {
	f, err := os.OpenFile("/dev/uinput", os.O_WRONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/uinput: %w", err)
	}
	fd := f.Fd()
	if err := ioctl(fd, uiSetEvbit, evSw); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_SET_EVBIT: %w", err)
	}
	if err := ioctl(fd, uiSetSwbit, swTabletMode); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_SET_SWBIT: %w", err)
	}
	setup := uinputSetup{ID: inputID{Bustype: 0x06, Vendor: 0x1, Product: 0x1, Version: 1}}
	copy(setup.Name[:], devName)
	if err := ioctl(fd, uiDevSetup, uintptr(unsafe.Pointer(&setup))); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_DEV_SETUP: %w", err)
	}
	if err := ioctl(fd, uiDevCreate, 0); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_DEV_CREATE: %w", err)
	}
	time.Sleep(300 * time.Millisecond) // give udev/libinput time to pick up the device
	return &device{f: f}, nil
}

func (d *device) emit(typ, code uint16, val int32) error {
	ev := inputEvent{Type: typ, Code: code, Value: val}
	b := (*[unsafe.Sizeof(ev)]byte)(unsafe.Pointer(&ev))[:]
	_, err := d.f.Write(b)
	return err
}

// apply executes an on/off/toggle/status command and returns the resulting
// state. Everything runs under one lock so the rate limit check is atomic.
func (d *device) apply(cmd string) (bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	want := d.state
	switch cmd {
	case "on":
		want = true
	case "off":
		want = false
	case "toggle":
		want = !d.state
	case "status":
		return d.state, nil
	}
	if want == d.state {
		return d.state, nil
	}

	// Layer 1: rate limit switching tablet mode ON. Switching off is always allowed.
	if want && !d.lastChange.IsZero() {
		if wait := minOnInterval - time.Since(d.lastChange); wait > 0 {
			return d.state, fmt.Errorf("too fast, try again in %d s", int(wait.Seconds())+1)
		}
	}

	var v int32
	if want {
		v = 1
	}
	if err := d.emit(evSw, swTabletMode, v); err != nil {
		return d.state, err
	}
	if err := d.emit(evSyn, 0, 0); err != nil {
		return d.state, err
	}
	d.state = want
	d.lastChange = time.Now()
	return d.state, nil
}

// peerCred returns the UID and PID of the process on the other end of the
// socket (SO_PEERCRED).
func peerCred(c net.Conn) (uid uint32, pid int32, err error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, 0, fmt.Errorf("not a unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var cred *syscall.Ucred
	var cerr error
	if err := raw.Control(func(fd uintptr) {
		cred, cerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, 0, err
	}
	if cerr != nil {
		return 0, 0, cerr
	}
	return cred.Uid, cred.Pid, nil
}

// Layer 3: only a UID with an active session on a local seat (the machine's
// own screen/keyboard) may send commands. root is always allowed. Reads the
// systemd-logind session files in /run/systemd/sessions (files named "ID",
// skipping "ID.ref").
func hasActiveLocalSession(uid uint32) bool {
	if uid == 0 {
		return true
	}
	files, _ := filepath.Glob(filepath.Join(sessionsDir, "*"))
	for _, f := range files {
		if strings.Contains(filepath.Base(f), ".") {
			continue // *.ref files are FIFOs; reading them would block
		}
		st, err := os.Stat(f)
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		kv := map[string]string{}
		for _, ln := range strings.Split(string(data), "\n") {
			if k, v, ok := strings.Cut(ln, "="); ok {
				kv[k] = v
			}
		}
		if kv["UID"] == fmt.Sprint(uid) && kv["STATE"] == "active" &&
			kv["SEAT"] != "" && kv["REMOTE"] != "1" {
			return true
		}
	}
	return false
}

func (d *device) close() {
	_ = ioctl(d.f.Fd(), uiDevDestroy, 0)
	d.f.Close()
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func handle(c net.Conn, d *device) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	line, err := bufio.NewReader(io.LimitReader(c, maxCmdLen)).ReadString('\n')
	if err != nil && line == "" {
		return
	}
	cmd := strings.TrimSpace(line)

	// Layer 2: log who sent which command (journalctl -u tabletmode).
	uid, pid, err := peerCred(c)
	if err != nil {
		logf("rejected, cannot read SO_PEERCRED: %v", err)
		fmt.Fprintln(c, "error: cannot identify the sender")
		return
	}
	switch cmd {
	case "on", "off", "toggle", "status":
	default:
		logf("uid=%d pid=%d invalid command (%d bytes)", uid, pid, len(cmd))
		fmt.Fprintln(c, "error: invalid command")
		return
	}
	if !hasActiveLocalSession(uid) {
		logf("DENIED uid=%d pid=%d cmd=%s (no active local session)", uid, pid, cmd)
		fmt.Fprintln(c, "error: permission denied (an active local login session is required)")
		return
	}

	state, err := d.apply(cmd)
	if err != nil {
		logf("uid=%d pid=%d cmd=%s -> blocked: %v", uid, pid, cmd, err)
		fmt.Fprintf(c, "error: %v\n", err)
		return
	}
	if cmd != "status" {
		logf("uid=%d pid=%d cmd=%s -> %s", uid, pid, cmd, onOff(state))
	}
	fmt.Fprintln(c, onOff(state))
}

func daemon() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("the daemon must run as root (use systemd)")
	}
	initLog()
	logf("starting daemon (pid=%d)", os.Getpid())
	d, err := newDevice()
	if err != nil {
		logf("failed to create uinput device: %v", err)
		return err
	}
	logf("created uinput device %q", devName)
	defer d.close()

	if err := os.MkdirAll("/run/tabletmode", 0o755); err != nil {
		return err
	}
	_ = os.Remove(sockPath)
	l, err := net.Listen("unix", sockPath)
	if err != nil {
		return err
	}
	defer os.Remove(sockPath)
	// Any user may connect; access is checked per command (local active
	// session). The switch only affects screen rotation and the on-screen keyboard.
	if err := os.Chmod(sockPath, 0o666); err != nil {
		return err
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sig
		logf("received signal %v, stopping", s)
		l.Close()
	}()

	logf("ready, state: off, socket %s", sockPath)
	sem := make(chan struct{}, maxConns)
	for {
		c, err := l.Accept()
		if err != nil {
			return nil // listener closed by the signal handler
		}
		select {
		case sem <- struct{}{}:
			go func() {
				defer func() { <-sem }()
				handle(c, d)
			}()
		default:
			logf("too many connections (%d), dropping one", maxConns)
			c.Close()
		}
	}
}

func client(cmd string) error {
	c, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		return fmt.Errorf("cannot connect to the service (check: systemctl status tabletmode): %w", err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := fmt.Fprintln(c, cmd); err != nil {
		return err
	}
	out, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		return err
	}
	out = strings.TrimSpace(out)
	if strings.HasPrefix(out, "error:") {
		return fmt.Errorf("%s", out)
	}
	syncScreenKeyboard(out == "on")
	fmt.Println(out)
	return nil
}

// syncScreenKeyboard enables the GNOME on-screen keyboard when entering
// tablet mode and disables it when leaving, using the settings of the user
// running the command. Skipped when running as root (gsettings would write
// root's settings, not the user's) or when gsettings fails.
func syncScreenKeyboard(on bool) {
	if os.Geteuid() == 0 {
		return
	}
	gs, err := exec.LookPath("gsettings")
	if err != nil {
		return
	}
	v := "false"
	if on {
		v = "true"
	}
	_ = exec.Command(gs, "set", "org.gnome.desktop.a11y.applications",
		"screen-keyboard-enabled", v).Run()
}

const usage = "usage: tabletmode daemon | on | off | toggle | status"

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "daemon":
		err = daemon()
	case "on", "off", "toggle", "status":
		err = client(os.Args[1])
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
