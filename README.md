# YouNote — Dịch trực tiếp YouTube

> Nghe mọi video YouTube bằng tiếng Việt (hoặc 12 ngôn ngữ khác). Lồng tiếng AI trực tiếp, dùng [Kyma](https://kymaapi.com) key của riêng bạn.

<p align="center">
  <img src="store-assets/screenshots/01-popup.png" alt="YouNote popup" width="400">
</p>

Chrome MV3 extension chèn lớp lồng tiếng AI trực tiếp lên video YouTube. Hai chế độ:

- **Tiêu chuẩn** *(mặc định)* — pipeline chia chunk (Whisper → Gemini → MiniMax), trễ ~5s, 5 giọng đa ngôn ngữ. ~$0.25 / 10 phút.
- **Thời gian thực** — WebRTC P2P, trễ <1 giây, 9 giọng OpenAI hoặc auto-clone giọng người nói. ~$0.46 / 10 phút.

13 ngôn ngữ đích. Không tài khoản, không telemetry, không server YouNote.

## Cài đặt

### Từ Chrome Web Store *(sắp ra mắt)*

Đang trong quá trình duyệt tại Chrome Web Store. Sau khi duyệt, cài 1 click.

### Từ source (developer mode)

1. Clone hoặc download repo
2. Mở `chrome://extensions`
3. Bật **Developer mode** (góc phải trên)
4. Bấm **Load unpacked**
5. Chọn thư mục đã clone
6. Pin YouNote vào toolbar

Cập nhật bằng `git pull` rồi bấm icon reload trên thẻ extension.

## Sử dụng

1. Mở 1 video YouTube bất kỳ
2. Bấm icon YouNote
3. Dán Kyma API key từ [kymaapi.com](https://kymaapi.com)
4. Chọn chế độ, ngôn ngữ đích, và giọng
5. Bấm **Bắt đầu** — phần dịch sẽ phát + panel trên trang hiện bản dịch trực tiếp
6. Kéo panel bằng toolbar; resize từ cạnh hoặc góc bất kỳ

Có thể đổi giọng/ngôn ngữ giữa session — Thời gian thực hot-swap <1s, Tiêu chuẩn áp dụng từ chunk 5s tiếp theo.

## Cách hoạt động

```
popup ◄──BACKGROUND_STATE_UPDATE──── background ◄──CONTENT_STATE──── content (trang YT)
       ───START / UPDATE_SETTINGS───►          ───CONTENT_START───►
```

- **popup.html / popup.js** — passive renderer, không giữ state riêng.
- **background.js** — single source of truth cho `state`. Inject content script qua `chrome.scripting.executeScript` nếu chưa có.
- **content.js** — capture audio video YT, dựng overlay panel trên trang, chạy pipeline:
  - **Tiêu chuẩn**: chia audio thành cửa sổ 5s qua `MediaRecorder`, re-encode WAV client-side, rồi chạy Whisper → Gemini → MiniMax TTS qua Kyma gateway. Web Audio scheduling xếp chunk mp3 phát liên tiếp.
  - **Thời gian thực**: mint Kyma ephemeral token, mở P2P WebRTC với OpenAI Realtime.

Token-guarded async (`pageToken` capture trong closure, check trước khi mutate state) tránh stale callback corrupt session mới khi user đổi setting hoặc Stop giữa chừng. `AbortController` cho mỗi Standard session hủy fetch in-flight ngay khi bấm Stop, không đốt credit cho chunk orphan.

## Việt hóa & đa ngôn ngữ

UI dùng `chrome.i18n` chuẩn với `_locales/vi/` (mặc định) + `_locales/en/`. Chrome tự pick locale theo cài đặt ngôn ngữ trình duyệt.

## Tính năng

- Onboarding 1 phím (dán Kyma key → Bắt đầu)
- 13 ngôn ngữ đích: Anh, Việt, Nhật, Hàn, Trung, Pháp, Tây Ban Nha, Đức, Bồ Đào Nha, Hindi, Indonesia, Ý, Nga
- Panel overlay drag/resize có lưu layout
- Lịch sử dịch (16 lượt gần nhất, scroll được)
- Phụ đề gốc (toggle trong popup)
- Slider âm lượng riêng cho audio gốc và lồng tiếng
- Khuếch đại giọng tới 2× qua Web Audio GainNode
- Pause/play tức thì (không reconnect)
- Auto-stop cứng 60 phút + cảnh báo trước 5 phút
- Cleanup khi đóng tab qua `keepalive` POST để Kyma thấy session kết thúc

## Giọng cho chế độ Tiêu chuẩn

Curated từ catalog 333 giọng của MiniMax. Tất cả đa ngôn ngữ — mỗi giọng nói được cả 13 ngôn ngữ đích.

- **Giọng Nam Cuốn Hút** — US, nam
- **Giọng Nữ Truyền Cảm** — US, nữ
- **Giọng Nam Trầm** — US, nam
- **Giọng Nữ Tự Tin** — US, nữ
- **Phát Thanh Viên** — nữ

## Bảo mật

YouNote không thu thập, lưu, hoặc bán dữ liệu cá nhân. Kyma API key của bạn ở yên trên máy bạn. Audio gửi trực tiếp tới các nhà cung cấp AI (Kyma, và OpenAI cho chế độ Thời gian thực) chỉ để dịch. Không có server YouNote.

Chính sách đầy đủ: [`store-assets/privacy-policy.html`](store-assets/privacy-policy.html)

## Build cho distribution (obfuscated)

Source folder dùng cho **dev** (load unpacked đọc thẳng JS rõ ràng để debug). Khi share/release cần đóng gói code obfuscated:

```bash
npm install        # lần đầu — kéo terser + javascript-obfuscator + archiver (~30 MB)
npm run build      # tạo dist/ với JS obfuscated, asset copy as-is
npm run pack       # build + zip → ~/younote-vX.Y.Z.zip
```

Hoặc dùng wrapper cũ:
```bash
./pack.sh          # tự npm install nếu cần, rồi npm run pack
```

### Folder để load unpacked

| Mục đích | Folder | Code dạng |
|---|---|---|
| Dev / debug | `d:\SourceCode\Echoly\` (root) | Plain JS, có comment |
| Distribute / share | `d:\SourceCode\Echoly\dist\` | Obfuscated (terser + string-array + mangle) |

Cả 2 đều load qua `chrome://extensions/` → Developer mode → Load unpacked. End user sẽ load `dist/` (giải nén từ zip).

### Pipeline kỹ thuật

[build.js](build.js) áp dụng:
- **Terser**: minify, dead-code elim, strip comment
- **javascript-obfuscator** (preset light): identifier mangle (mangled-shuffled), string-array base64-encoded với 2 wrapper layer, `splitStrings`, `numbersToExpressions`
- **Tắt** control-flow flattening + dead-code injection (giữ performance Realtime tier)
- **Tắt** selfDefending + debugProtection (an toàn extension context, Web Store reviewer-friendly)
- **Giữ** `transformObjectKeys: false` + `renameGlobals: false` để `chrome.*` API string-key reflection không vỡ

## Roadmap

- Session log per-tab (đo cost trực tiếp)
- Warm ngôn ngữ khi hover (chuyển <200ms cho Realtime)
- Tra từ điển trên text phụ đề gốc highlight
- Port Firefox

## Đóng góp

Issue và PR đều welcome. Codebase JS thuần — không build step, không dependency. Pre-flight checklist trước PR:

- `node --check content.js && node --check background.js && node --check popup.js`
- Test thủ công trong extension đã reload trên ít nhất 1 video YouTube tiếng Anh, cả 2 chế độ
- Nếu sửa `manifest.json`, bump version và update đồng bộ `manifest.json` + hằng `YOUNOTE_VERSION` trong `content.js`

## Lưu trữ và xuất bản dịch

Mỗi lượt dịch (cả phần gốc + phần thuyết minh) được lưu cục bộ vào `chrome.storage.local`, giới hạn 500 lượt gần nhất (FIFO). Nút **Tải** trên toolbar overlay xuất toàn bộ lịch sử dịch ra file `.txt` UTF-8 với format:

```
[2026-05-14 14:32:08]
  Gốc: Welcome back to the channel...
  Dịch: Chào mừng bạn quay lại kênh...
```

File tên `younote-YYYYMMDD-HHmm.txt`. Lịch sử persist qua nhiều session, kèm URL video gốc trong header file để tra ngược dễ.

## Sản phẩm

YouNote là sản phẩm của **VCI** — đội ngũ phát triển công cụ AI và productivity bởi **cuongbx**.

## License

[MIT](LICENSE) © 2026 cuongbx · VCI
