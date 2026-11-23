package main

import (
	"os"
	"strings"
	"testing"
)

func TestRateLimit(t *testing.T) {
	f, err := os.OpenFile("/dev/null", os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	d := &device{f: f}

	if s, err := d.apply("on"); err != nil || !s {
		t.Fatalf("first on must succeed: %v %v", s, err)
	}
	if s, err := d.apply("off"); err != nil || s {
		t.Fatalf("off must always succeed: %v %v", s, err)
	}
	if _, err := d.apply("on"); err == nil || !strings.Contains(err.Error(), "too fast") {
		t.Fatalf("on right after a change must be blocked, got %v", err)
	}
	if _, err := d.apply("toggle"); err == nil {
		t.Fatalf("toggle to on right after a change must be blocked")
	}
	if s, err := d.apply("status"); err != nil || s {
		t.Fatalf("status must always succeed and still be off: %v %v", s, err)
	}
	if s, err := d.apply("off"); err != nil || s {
		t.Fatalf("off while already off must not fail: %v %v", s, err)
	}
}

func TestSessionCheck(t *testing.T) {
	if !hasActiveLocalSession(0) {
		t.Error("root must be allowed")
	}
	if hasActiveLocalSession(4242424) {
		t.Error("unknown uid without a session must be denied")
	}
	if !hasActiveLocalSession(uint32(os.Getuid())) {
		t.Skip("current user has no active local session (running over ssh?)")
	}
}
