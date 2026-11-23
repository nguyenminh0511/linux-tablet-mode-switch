# Trạng thái công việc: xoay màn hình khi bật Tablet Mode (cập nhật 2026-11-23)

Máy: GPD Pocket 4 (G1628-04-L), GNOME Shell 46, Wayland. Cảm biến gia tốc MXC6655.

## Vấn đề ban đầu
Bật tablet mode khi máy đặt thẳng thì màn hình bị xoay sai. Code `tabletmode`
(main.go) chỉ phát SW_TABLET_MODE qua uinput, KHÔNG tự xoay; GNOME đọc cảm biến
(iio-sensor-proxy) khi tablet mode bật rồi mới xoay.

## Nguyên nhân đã xác định
- Cảm biến báo `right-up` khi máy đặt thẳng (hướng ngang bình thường), vì gắn
  lệch 90° so với tấm nền. Không có ACCEL_MOUNT_MATRIX cho Pocket 4 trong
  /usr/lib/udev/hwdb.d/60-sensor.hwdb (chỉ có Pocket 3).
- Giá trị thô lúc thẳng: x≈0, y≈-925, z≈-690.
- Hướng khi có ma trận 90° đã thử (x'=y, y'=-x): x≈+1000→normal, x≈-1100→bottom-up,
  y≈+786→left-up, y≈-925→right-up.

## Quyết định của người dùng
KHÔNG sửa cấu hình cảm biến bằng hwdb. Giữ mặc định của máy (right-up là hướng
ngang bình thường). Thay vào đó sửa tool `tabletmode` để tự bù lệch.
Hành vi mong muốn: tự xoay theo máy; thẳng = ngang bình thường; nghiêng trái/phải/úp
thì xoay theo.

## Đã làm (chưa commit)
- `extension/extension.js`: thêm `RotationController`. Khi bật tablet mode: đặt
  `orientation-lock=true` (chặn GNOME tự xoay lệch), đọc `net.hadess.SensorProxy`
  (system bus), xoay qua `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig`.
  Khi tắt: khôi phục khóa cũ và về transform 0. Poll `tabletmode status` mỗi 2 giây.
- Bảng bù lệch (suy luận, CHƯA kiểm chứng trên máy thật):
  `right-up→0, normal→1, left-up→2, bottom-up→3` (transform Mutter).
- `main.go` không đổi.

## Cập nhật sau đó (cùng ngày)
- ĐÃ gỡ rule hwdb; xác nhận không còn ACCEL_MOUNT_MATRIX. Ở mặc định thật, máy thẳng
  vẫn báo `right-up` (x≈-7, y≈-929, z≈-656), nên giả định của bảng bù lệch là đúng.
- ĐÃ chạy `./install.sh`; extension đã cài giống bản trong repo; dịch vụ tabletmode active.
- Extension đang `Enabled: No / INITIALIZED`: shell chưa nạp bản mới.

## Cập nhật cuối (2026-11-23)
- Nguyên nhân bị khóa ngang: extension chưa được enable sau khi đăng nhập lại
  (`enabled-extensions` rỗng). Đã `gnome-extensions enable tabletmode@local` thì
  xoay hoạt động; NGƯỜI DÙNG ĐÃ XÁC NHẬN nghiêng máy xoay đúng chiều (bảng
  `ORIENTATION_TO_TRANSFORM` đúng, không cần đổi).
- Nút Auto Rotate gốc của GNOME vô hiệu khi tablet mode bật (vì extension giữ
  orientation-lock=true). Đã thêm nút "Khóa xoay màn hình" (RotationLockToggle):
  bật = giữ hướng hiện tại, tắt = xoay theo cảm biến. Nút gốc bị ẩn khi tablet mode
  bật (qua `Main.panel.statusArea.quickSettings._rotation`, thuộc tính nội bộ GNOME 46).
- Bản có nút khóa mới ĐÃ COMMIT nhưng CHƯA CÀI/CHƯA CHẠY THỬ (cần sudo).

## Cập nhật: sửa xoay nghiêng lúc bật + ẩn nút gốc (commit 9bf08cf)
- Hiện tượng: bật tablet mode thì màn hình xoay nghiêng 1 lần rồi mới về ngang.
  Nguyên nhân (suy luận, CHƯA kiểm chứng): cảm biến vừa claim báo hướng tạm thời
  (vd `normal` -> transform 1) trước khi ổn định `right-up`; `_current=null` nên
  lần apply đầu luôn chạy; nhiều `ApplyMonitorsConfig` có thể chồng nhau.
- Đã sửa: `_update()` debounce 400ms (`DEBOUNCE_MS`) rồi mới đọc hướng; `_apply()`
  tuần tự hóa (`_busy`/`_queued`); `stop()` hủy timer.
- Nút Auto Rotate gốc: ẩn hẳn khi extension bật (không phụ thuộc tablet mode), giữ
  ẩn qua `notify::visible`, hiện lại khi extension disable. Nút "Khóa xoay màn hình"
  của extension vẫn giữ.
- CHƯA cài, CHƯA chạy thử (chỉ kiểm tra cú pháp được hạn chế; không có node).

## Việc cần làm tiếp
1. `cd ~/tablet-mode && ./install.sh`, ĐĂNG XUẤT/ĐĂNG NHẬP, kiểm tra
   `gnome-extensions info tabletmode@local`; nếu chưa Enabled thì
   `gnome-extensions enable tabletmode@local`.
2. Thử: bật tablet mode, nút "Khóa xoay màn hình" có hiện không, bật khóa thì
   nghiêng máy không xoay, tắt khóa thì xoay lại; nút Auto Rotate gốc luôn bị ẩn;
   bật tablet mode không còn xoay nghiêng 1 lần trước khi về ngang.
3. Nếu lỗi: `journalctl -b /usr/bin/gnome-shell | grep -i tabletmode`.

## Rollback
- Extension: `git checkout <commit trước>` -- extension/extension.js rồi `./install.sh`.
