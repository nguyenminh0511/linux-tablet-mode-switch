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
		t.Fatalf("on lần đầu phải được: %v %v", s, err)
	}
	if s, err := d.apply("off"); err != nil || s {
		t.Fatalf("off phải luôn được: %v %v", s, err)
	}
	if _, err := d.apply("on"); err == nil || !strings.Contains(err.Error(), "quá nhanh") {
		t.Fatalf("on ngay sau khi đổi phải bị chặn, got %v", err)
	}
	if _, err := d.apply("toggle"); err == nil {
		t.Fatalf("toggle sang on ngay sau khi đổi phải bị chặn")
	}
	if s, err := d.apply("status"); err != nil || s {
		t.Fatalf("status luôn được và vẫn off: %v %v", s, err)
	}
	if s, err := d.apply("off"); err != nil || s {
		t.Fatalf("off khi đã off không lỗi: %v %v", s, err)
	}
}

func TestSessionCheck(t *testing.T) {
	if !hasActiveLocalSession(0) {
		t.Error("root phải được")
	}
	if hasActiveLocalSession(4242424) {
		t.Error("uid lạ không có phiên phải bị từ chối")
	}
	if !hasActiveLocalSession(uint32(os.Getuid())) {
		t.Skip("user hiện tại không có phiên cục bộ active (chạy qua ssh?)")
	}
}
