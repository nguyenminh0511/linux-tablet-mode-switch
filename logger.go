package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Daemon log: written to stdout (journalctl -u tabletmode) and, if
// TABLETMODE_LOG_DIR is set, to $TABLETMODE_LOG_DIR/daemon.log (rotated at 5 MB).
const maxLogSize = 5 << 20

var (
	logMu   sync.Mutex
	logFile *os.File
)

func initLog() {
	dir := os.Getenv("TABLETMODE_LOG_DIR")
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o777); err != nil {
		fmt.Printf("tabletmode: cannot create log directory %s: %v\n", dir, err)
		return
	}
	p := filepath.Join(dir, "daemon.log")
	if st, err := os.Stat(p); err == nil && st.Size() > maxLogSize {
		_ = os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o666)
	if err != nil {
		fmt.Printf("tabletmode: cannot open %s: %v\n", p, err)
		return
	}
	logFile = f
}

func logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Println("tabletmode: " + msg)
	logMu.Lock()
	defer logMu.Unlock()
	if logFile != nil {
		fmt.Fprintf(logFile, "%s [daemon] %s\n", time.Now().Format("2006-01-02 15:04:05.000"), msg)
	}
}
