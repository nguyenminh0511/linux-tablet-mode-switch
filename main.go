// tabletmode: công tắc Tablet Mode ảo cho GPD Pocket 4 (và máy tương tự).
//
//	tabletmode daemon          chạy dịch vụ (cần root, systemd chạy cái này)
//	tabletmode on|off|toggle   đổi chế độ (user có phiên đăng nhập cục bộ đang hoạt động)
//	tabletmode status          in "on" hoặc "off"
//
// Daemon tạo một thiết bị input ảo có SW_TABLET_MODE qua /dev/uinput, và nhận
// lệnh qua unix socket. Chỉ dùng thư viện chuẩn của Go.
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
	maxCmdLen = 64 // byte; lệnh hợp lệ chỉ vài ký tự
	maxConns  = 16

	// Lớp 1: chuyển sang tablet mode (on) chỉ được cách lần đổi trước ít nhất
	// khoảng này. "off" không bao giờ bị giới hạn để người dùng luôn thoát được.
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
		return nil, fmt.Errorf("mở /dev/uinput: %w", err)
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
	time.Sleep(300 * time.Millisecond) // chờ udev/libinput nhận thiết bị
	return &device{f: f}, nil
}

func (d *device) emit(typ, code uint16, val int32) error {
	ev := inputEvent{Type: typ, Code: code, Value: val}
	b := (*[unsafe.Sizeof(ev)]byte)(unsafe.Pointer(&ev))[:]
	_, err := d.f.Write(b)
	return err
}

// apply thực hiện một lệnh on/off/toggle/status và trả về trạng thái sau cùng.
// Toàn bộ chạy dưới một khóa nên việc giới hạn tần suất là nguyên tử.
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

	// Lớp 1: giới hạn tần suất khi BẬT tablet mode. Tắt thì luôn được.
	if want && !d.lastChange.IsZero() {
		if wait := minOnInterval - time.Since(d.lastChange); wait > 0 {
			return d.state, fmt.Errorf("quá nhanh, thử lại sau %d giây", int(wait.Seconds())+1)
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

// peerCred lấy UID và PID của tiến trình đầu bên kia socket (SO_PEERCRED).
func peerCred(c net.Conn) (uid uint32, pid int32, err error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, 0, fmt.Errorf("không phải unix socket")
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

// Lớp 3: chỉ UID có phiên đăng nhập đang hoạt động (active) trên một seat cục bộ
// (màn hình/bàn phím của máy) mới được gửi lệnh. root luôn được. Đọc các file
// phiên của systemd-logind trong /run/systemd/sessions (file "ID", bỏ qua "ID.ref").
func hasActiveLocalSession(uid uint32) bool {
	if uid == 0 {
		return true
	}
	files, _ := filepath.Glob(filepath.Join(sessionsDir, "*"))
	for _, f := range files {
		if strings.Contains(filepath.Base(f), ".") {
			continue // *.ref là FIFO, đọc sẽ bị treo
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

	// Lớp 2: ghi nhật ký (journalctl -u tabletmode) ai gửi lệnh gì.
	uid, pid, err := peerCred(c)
	if err != nil {
		fmt.Printf("tabletmode: từ chối, không đọc được SO_PEERCRED: %v\n", err)
		fmt.Fprintln(c, "error: không xác định được người gửi")
		return
	}
	switch cmd {
	case "on", "off", "toggle", "status":
	default:
		fmt.Printf("tabletmode: uid=%d pid=%d lệnh không hợp lệ (%d byte)\n", uid, pid, len(cmd))
		fmt.Fprintln(c, "error: lệnh không hợp lệ")
		return
	}
	if !hasActiveLocalSession(uid) {
		fmt.Printf("tabletmode: TỪ CHỐI uid=%d pid=%d lệnh=%s (không có phiên cục bộ đang hoạt động)\n", uid, pid, cmd)
		fmt.Fprintln(c, "error: không có quyền (cần phiên đăng nhập đang hoạt động trên máy)")
		return
	}

	state, err := d.apply(cmd)
	if err != nil {
		fmt.Printf("tabletmode: uid=%d pid=%d lệnh=%s -> bị chặn: %v\n", uid, pid, cmd, err)
		fmt.Fprintf(c, "error: %v\n", err)
		return
	}
	if cmd != "status" {
		fmt.Printf("tabletmode: uid=%d pid=%d lệnh=%s -> %s\n", uid, pid, cmd, onOff(state))
	}
	fmt.Fprintln(c, onOff(state))
}

func daemon() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("daemon cần chạy bằng root (dùng systemd)")
	}
	d, err := newDevice()
	if err != nil {
		return err
	}
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
	// Mọi user đăng nhập đều được đổi chế độ (chỉ ảnh hưởng xoay màn hình, bàn phím).
	if err := os.Chmod(sockPath, 0o666); err != nil {
		return err
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		l.Close()
	}()

	fmt.Println("tabletmode: sẵn sàng, trạng thái: off")
	sem := make(chan struct{}, maxConns)
	for {
		c, err := l.Accept()
		if err != nil {
			return nil // đã đóng bởi tín hiệu
		}
		select {
		case sem <- struct{}{}:
			go func() {
				defer func() { <-sem }()
				handle(c, d)
			}()
		default:
			c.Close() // quá nhiều kết nối: bỏ qua
		}
	}
}

func client(cmd string) error {
	c, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		return fmt.Errorf("không kết nối được dịch vụ (systemctl status tabletmode): %w", err)
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

// syncScreenKeyboard bật bàn phím ảo của GNOME khi vào tablet mode và tắt khi
// ra, bằng cài đặt của chính user đang chạy lệnh. Bỏ qua nếu chạy bằng root
// (gsettings sẽ ghi vào cài đặt của root, không phải user) hoặc gsettings lỗi.
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

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "dùng: tabletmode daemon | on | off | toggle | status")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "daemon":
		err = daemon()
	case "on", "off", "toggle", "status":
		err = client(os.Args[1])
	default:
		fmt.Fprintln(os.Stderr, "dùng: tabletmode daemon | on | off | toggle | status")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "lỗi:", err)
		os.Exit(1)
	}
}
