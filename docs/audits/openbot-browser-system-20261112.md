# OpenBot Browser System — Deep Architectural & Performance Audit
**Target Repository:** `/workspaces/openbot-fork`  
**Audit Date:** 2026-11-12  
**Target Runtime:** Linux Ubuntu 24.04 Noble container (`openbot-vm` via Incus, `OPENBOT_SERVER=1`, Xvfb `:99`)  
**Auditor:** Subagent (Architectural & Performance Reviewer)

---

## 1. Executive Summary

Audit ini mencakup analisis menyeluruh terhadap sistem browser di OpenBot (`/workspaces/openbot-fork`), meliputi arsitektur engine internal, integrasi driver CUA, manajemen profil & proxy, pipeline streaming remote live view, serta footprint performa di container headless VM (`openbot-vm`).

### Temuan Kunci (Key Findings):
1. **Engine Browser Native Electron + Raw CDP:** OpenBot **tidak** menggunakan Playwright maupun Puppeteer. Browser internal berjalan di atas Electron `WebContentsView` yang dikendalikan via raw Chrome DevTools Protocol (CDP) level 1.3 melalui `this.#contents.debugger` (`src/backend/browser-cdp.ts:3476`).
2. **Dual-Driver GUI Separation:** OpenBot memisahkan otomasi menjadi dua domain independen:
   - *Embedded Browser Domain:* WebContentsView + CDP (`src/backend/browser-*`) untuk interaksi web level DOM/AXTree.
   - *Desktop OS Domain (CUA):* Daemon eksternal `cua-driver` via `driver.sock` & `tap.sock` (`src/main/cua-driver-runtime.ts`) untuk otomasi aplikasi desktop di level display server.
3. **Dual Xvfb Headless Display Architecture:** Pada Linux headless server (`OPENBOT_SERVER=1`), server menjalankan **dua server Xvfb simultan**: display utama OpenBot (`DISPLAY`) dan display terisolasi untuk agen (`OPENBOT_AGENT_DISPLAY`). Untuk menjaga Chromium tetap merender frame di Linux headless, OpenBot membuat background window 1x1 pixel transparan (`createBackgroundWindow()`).
4. **Proxy Loopback Relay & WebRTC IP Leak Risk:** Chromium tidak mendukung otentikasi upstream SOCKS5 secara native; OpenBot mengatasinya dengan menjalankan local HTTP-to-SOCKS5 proxy relay pada `127.0.0.1:<random_port>` (`src/backend/browser-profiles/browser-proxy-relay.ts`). Namun, proteksi anti-leak WebRTC `disable_non_proxied_udp` **hanya diaktifkan jika tab memiliki konfigurasi proxy spesifik** (`src/backend/browser-host.ts:3559`), membuka celah kebocoran IP asli host untuk koneksi langsung.
5. **Fingerprint Anomaly di Lingkungan Headless:** Deteksi anti-bot (Cloudflare, Kasada, Datadome) sangat berisiko terpicu akibat penggunaan SwiftShader software rasterizer (`--enable-unsafe-swiftshader`) yang mengekspos `Google SwiftShader` / `llvmpipe` pada WebGL `UNMASKED_RENDERER_WEBGL` tanpa spoofing hardware GPU.
6. **CDP Snapshot N+1 Flooding:** Fungsi `collectActionableNodesEffect` (`src/backend/browser-cdp-snapshot.ts:745-755`) mengeksekusi 3 panggilan CDP konkuren per candidate node (`DOM.describeNode`, `Accessibility.getPartialAXTree`, `Runtime.callFunctionOn`) hingga 200 node per batch (mencapai 600 CDP calls konkuren), menimbulkan lonjakan latensi IPC dan CPU main thread.
7. **Resource Thrashing di Container VM (`openbot-vm`):**
   - Menonaktifkan throttling tab background (`backgroundThrottling: false` di `src/backend/browser-host.ts:399`) memaksa Chromium mengeksekusi timer JavaScript dan CSS animation pada background tabs dengan kecepatan penuh di atas CPU rendering, menghabiskan alokasi 6 vCPU.
   - Streaming live view via CDP screencast mem-parsing Base64 JPEG di V8 main thread pada rate 30 FPS (~9 MB/s GC churn), yang berisiko memblokir event loop dan memicu timeout watchdog HTTP liveness (`openbot-watchdog.timer` timeout >15s) sehingga daemon ter-kill berulang kali.
   - Risiko cgroup process exhaustion: container limit `limits.processes=512` berhadapan dengan ~240 base threads daemon OpenBot + browser renderers. Aktivitas subagent paralel dan build tool CLI dapat memicu kegagalan `fork: Resource temporarily unavailable` (EAGAIN).
8. **Monolit Kode Ekstrem (Pelanggaran OMP Max 700 Lines):**
   - `src/backend/browser-host.ts`: **4,818 baris** (6.8x dari batas standar 700 baris).
   - `src/backend/browser-cdp.ts`: **3,859 baris** (5.5x dari batas standar).
   - `src/backend/browser-cdp-snapshot.ts`: **968 baris**.
   - `src/main/cua-driver-runtime.ts`: **971 baris**.

---

## 2. Arsitektur Browser Engine & Driver

### 2.1 Evaluasi Driver & CDP Bindings
OpenBot mengimplementasikan arsitektur browser embedded langsung di dalam Electron runtime. Tidak terdapat dependensi eksternal terhadap Playwright, Puppeteer, atau Selenium.

- **Komponen Inti:**
  - `BrowserHost` (`src/backend/browser-host.ts`): Mengelola siklus hidup tab, window placement, persistensi sesi, partisi profil, dan routing aksi agen.
  - `BrowserCdpEngine` (`src/backend/browser-cdp.ts`): Membungkus sesi CDP interaktif.
  - **CDP Attachment:** Menggunakan API bawaan Electron:
    ```typescript
    // src/backend/browser-cdp.ts:3476
    yield* browserSync(() => this.#contents.debugger.attach("1.3"));
    ```
  - **Sesi Frame & Multiplexing:**
    ```typescript
    // src/backend/browser-cdp.ts:3494-3499
    yield* send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    });
    ```
    Engine secara otomatis meng-attach debugger ke seluruh subframe (iframe) secara flattened, memungkinkan eksekusi aksi, pengisian form, dan snapshot melintasi cross-origin iframes.
  - **BrowserView vs WebContentsView:** OpenBot menggunakan `WebContentsView` (`src/backend/browser-host.ts:3446`), arsitektur modern Electron yang menggantikan kelas legacy `BrowserView`. View ini dipasang secara modular ke window Electron melalui `this.#window.contentView.addChildView(view)`.

### 2.2 Relasi Dual-Driver: Embedded Browser vs CUA Driver
OpenBot membedakan secara tegas batas kerja antara browser internal dan lingkungan OS:

```
                      +---------------------------------------+
                      |           Agent Provider / LLM        |
                      +-------------------+-------------------+
                                          |
                   +----------------------+----------------------+
                   |                                             |
                   v (Tools: open, click, type, snapshot, etc.)   v (MCP Tool: cua-driver mcp)
+------------------------------------+         +------------------------------------+
|        OpenBot BrowserHost         |         |       CuaDriverActionTap           |
|     (src/backend/browser-host.ts)  |         |   (src/main/cua-driver-action-tap) |
|                 |                  |         |         tap.sock (Proxy)           |
|                 v                  |         +-----------------+------------------+
|          BrowserCdpEngine          |                           |
|      (webContents.debugger)        |                           v driver.sock
|                 |                  |         +------------------------------------+
|                 v                  |         |         cua-driver Daemon          |
|      Electron WebContentsView      |         |   (Native Rust Binary / Input Hook)|
|   (DOM, AXTree, Synthetic Input)   |         +-----------------+------------------+
+-----------------+------------------+                           |
                  |                                              v
                  v                                 +-------------------------------+
        +-------------------+                       |   Agent Xvfb Virtual Screen   |
        |  OpenBot Display  |                       |   (OPENBOT_AGENT_DISPLAY=:0)  |
        |   (DISPLAY=:99)   |                       |   (OS Desktop, Terminals, GUI)|
        +-------------------+                       +-------------------------------+
```

- **Embedded Browser:** Ditujukan khusus untuk navigasi web internal yang terisolasi. Agen berinteraksi menggunakan semantic snapshot (AXTree node refs), form filling terproteksi (`submit_secret`, `fill_card`), dan CDP synthetic input (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`).
- **CUA Driver (`cua-driver`):** Daemon native (berbasis Rust) yang mengontrol display OS desktop.
  - Daemon berjalan sebagai child process berumur panjang yang mendengarkan Unix socket `driver.sock` (`src/main/cua-driver-runtime.ts:29`).
  - OpenBot memasang proxy perantara `CuaDriverActionTap` pada `tap.sock` (`src/main/cua-driver-action-tap.ts`).
  - **Fungsi `tap.sock`:**
    1. Melacak koordinat aksi agen (`lastAction`, `lastPointer`) tanpa perlu query daemon.
    2. Menyaring daftar tool cursor driver (`--no-overlay`) agar kursor agen dirender sendiri oleh OpenBot layer.
    3. Menginjeksi representasi JSON ringkas ke dalam respon `structuredContent` untuk model LLM (Codex/Claude) yang hanya menerima output teks (`src/main/cua-driver-structured-text.ts`).
  - Instruksi agen (`src/backend/agent/developer-instructions.ts:580`) secara eksplisit mewajibkan: *"Use Computer Use for every GUI task outside the embedded browser, never Codex Computer Use... OpenBot draws your cursor..."*.

### 2.3 Transisi Headless Server (`OPENBOT_SERVER=1`)
Saat OpenBot dijalankan pada container headless tanpa display monitor fisik:
1. **Pemisahan Display Server:**
   - Script startup `scripts/hosting/openbot-hosted-server` mengeksekusi dua instance Xvfb:
     ```bash
     exec xvfb-run -a -s "-screen 0 $(display_size "$requested_size")x24 -nolisten tcp -wr" \
       bash -c 'export OPENBOT_AGENT_DISPLAY=$DISPLAY; exec xvfb-run -a -f "$XAUTHORITY" -s "-screen 0 1280x800x24 -nolisten tcp" "$@"' \
       openbot-hosted-server "${openbot[@]}"
     ```
   - `OPENBOT_AGENT_DISPLAY`: Display virtual terpisah untuk CUA driver, remote desktop, dan proses aplikasi eksternal yang di-spawn oleh agen.
   - `DISPLAY`: Display virtual tempat Electron merender WebContentsView browser internal.
2. **Workaround Chromium Hidden View di Linux:**
   - Pada Linux/X11, Chromium secara native **tidak akan merender atau memproses compositing frame untuk view yang tersembunyi atau window yang diminimize**.
   - Solusi OpenBot: `src/backend/browser-host.ts:406-437` membuat `#backgroundWindow` berukuran 1x1 pixel (`BaseWindow` dengan `focusable: false`, `skipTaskbar: true`, `opacity: 0`).
   - Setiap tab `WebContentsView` di-mount ke dalam background window 1x1 pixel ini (`SHOWS_VIEWS_IN_BACKGROUND = true` di Linux). Chromium tetap menganggap view tersebut visible sehingga pipeline screencast CDP tetap memproduksi frame.
3. **Konfigurasi GPU Headless:**
   - `src/main/linux-gpu-mode.ts:131-136`:
     ```typescript
     if (mode.reason === "server") {
       app.commandLine.appendSwitch("disable-gpu-compositing");
       app.commandLine.appendSwitch("enable-unsafe-swiftshader");
     }
     ```
   - GPU compositing dimatikan (compositing, raster, 2D canvas, dan video decoding dialihkan sepenuhnya ke CPU).
   - SwiftShader (CPU software rasterizer) diaktifkan untuk menyediakan konteks WebGL agar situs berat seperti Figma atau Canva tidak crash.

---

## 3. Browser Profiles, Proxies, & Isolation

### 3.1 Kontrak Protokol Profil & Proxy
Kontrak jaringan team protocol didefinisikan dalam modul beku (frozen wire contracts):
- `packages/contracts/src/team-protocol/browser-profiles-v1.ts`:
  - Rute: `/v1/admin/browser-profiles`, `/create`, `/update`, `/clear`, `/delete`, `/v1/browser/tab-profiles`.
  - Struktur profil: `id` (32 hex characters), `name` (max 60 chars), `hue` (pilihan warna 10 preset), `agentIds` (daftar agen yang terikat), `tabCount`.
  - Opsi binding agen: `shared` (partisi bersama), `agent` (partisi privat agen), atau `profile` (partisi profil bersama tertentu).
- `packages/contracts/src/team-protocol/browser-proxies-v1.ts`:
  - Rute: `/v1/admin/browser-proxies`, `/save`, `/delete`, `/v1/admin/browser-profiles/proxy`, `/computer`.
  - Protokol didukung: `socks5`, `http`, `https`.
  - Keamanan kredensial: Password proxy hanya dikirim saat pembuatan/pembaruan via encrypted transit, tidak pernah dikembalikan dalam query list (`hasPassword: boolean`).
  - Fitur `computer`: Memungkinkan perutean profil browser keluar melalui desktop app milik anggota tim lain (`browser-egress-v1`).

### 3.2 Partisi Sesi & Penyimpanan State
OpenBot membagi sesi browser ke dalam partisi Electron independen (`src/backend/browser-host.ts`):
1. **Shared Persistent Partition:** `session.fromPartition("persist:openbot-browser", { cache: true })` (baris 741). Sesi default untuk agen yang menggunakan profil bersama. Cookie, localStorage, dan cache tersimpan persisten di disk.
2. **Profile Persistent Partition:** `session.fromPartition("persist:${partition}", { cache: true })` (baris 3178, 3389). Partisi persisten terisolasi untuk profil tertentu.
3. **Private Ephemeral Partition:** `session.fromPartition("openbot-private-${randomUUID()}", { cache: false })` (baris 1082). Sesi in-memory murni tanpa cache disk, langsung dibuang saat tab ditutup.
4. **Pembersihan State Profil:** Rute `/clear` mengeksekusi penghapusan storage data Chromium:
   ```typescript
   // src/backend/browser-profiles/browser-profile-store.ts
   yield* browserCall(() => target.clearStorageData());
   ```
   Menghapus seluruh cookies, service workers, cache storage, indexedDB, dan local storage.

### 3.3 Loopback SOCKS5 Proxy Relay
Chromium dan Electron memiliki keterbatasan fundamental: **tidak mendukung autentikasi user/password pada proxy upstream SOCKS5 secara native**.
Untuk mengatasi ini, OpenBot merancang proxy relay in-process:
- `src/backend/browser-profiles/browser-proxy-relay.ts`:
  - Membuka HTTP proxy lokal pada `127.0.0.1:<random_ephemeral_port>` dengan kredensial Basic Auth acak (`openbot:<random_secret>`).
  - Saat browser mengirim permintaan `CONNECT` atau HTTP biasa, relay meneruskannya ke fungsi `socksExit` (implementasi RFC 1929 SOCKS5 client) atau `computerExit` (WebRTC tunnel).
  - Partisi sesi Electron kemudian diarahkan ke proxy relay lokal:
    ```typescript
    // src/backend/browser-host.ts:3256
    target.setProxy(rules === null ? { mode: "system" } : { mode: "fixed_servers", proxyRules: rules });
    ```

### 3.4 Analisis Kebocoran IP & Anti-Fingerprint
#### Celah Kebocoran WebRTC (WebRTC IP Leak)
Pemeriksaan kode pada `src/backend/browser-host.ts:3559`:
```typescript
// WebRTC must not send UDP around the proxy: the page would see the real address.
if (this.#tabProxy(tab)) contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
```
- **VULNERABILITY RISK (HIGH):** Kebijakan `disable_non_proxied_udp` **hanya** diterapkan jika tab memiliki objek proxy yang terpasang (`this.#tabProxy(tab)` bernilai true).
- Jika tab berjalan pada profil default tanpa proxy (direct host network) atau proxy sistem host, kebijakan IP WebRTC tetap berada pada default Chromium (`default`), yang memungkinkan WebRTC ICE gathering mengirim paket STUN via UDP ke seluruh antarmuka jaringan fisik/virtual. Di lingkungan container (`openbot-vm`), ini dapat membocorkan IP internal Incus (`10.32.76.252`) atau IP publik host ke situs yang dikunjungi.

#### Evaluasi Proteksi Fingerprint
1. **Preload Script (`src/preload/browser-page.ts` - `matchChromePageValues`):**
   - Mengganti `Function.prototype.toString` via Proxy untuk mengembalikan `function [name]() { [native code] }` guna menyamarkan injeksi JavaScript.
   - Menginjeksi stub properti `window.chrome`: `loadTimes`, `csi`, dan objek `app` (`isInstalled`, `getDetails`).
   - Mengoreksi inkonsistensi ukuran window (`outerWidth`, `outerHeight`, `screenX`, `screenY`) saat window berada dalam mode headless/minimized agar tidak terdeteksi 0x0.
   - Mematikan passkey dialog pada macOS (`refusePasskeyDialogs`).
2. **Header & Client Hints (`src/backend/browser-identity.ts`):**
   - Membersihkan User-Agent dari string `Electron/` dan `OpenBot/` (`sessionBrowserUserAgent`).
   - Menghasilkan header Client Hints Chromium GREASE yang konsisten (`Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`).
   - Menyimpan cache `Accept-CH` per origin (`BrowserHintRequests`).
   - Pengecualian Google Auth: String `Electron/` dipertahankan khusus untuk request ke `accounts.google.com` (baris 18) karena Google Auth secara aktif memblokir OAuth flow jika token Electron dihilangkan.
3. **GAP FINGERPRINT KRITIS (Headless Detection):**
   - **SwiftShader Renderer Leak:** Di container headless `openbot-vm`, parameter `--enable-unsafe-swiftshader` menyebabkan pemanggilan WebGL `gl.getParameter(debugRendererInfo.UNMASKED_RENDERER_WEBGL)` mengembalikan string:
     `Google SwiftShader` atau `Android Emulator OpenGL ES Translator (Google SwiftShader)` atau `llvmpipe (LLVM ...)`.
     Sistem anti-bot modern (Cloudflare Turnstile, Kasada, DataDome) secara otomatis menandai string renderer ini sebagai bot headless dengan skor risiko maksimal.
   - **Canvas & WebAudio Fingerprinting:** Tidak ada modul pengacakan noise pada Canvas 2D (`toDataURL`, `getImageData`) maupun WebAudio API `OfflineAudioContext`.
   - **Hardware Concurrency & Device Memory:** Tidak ada spoofing terhadap `navigator.hardwareConcurrency` dan `navigator.deviceMemory`, mengekspos jumlah vCPU container (6 core) secara mentah.

---

## 4. Remote Browser View & Interactive Takeover

### 4.1 Pipeline Streaming Feed Browser
Arsitektur streaming OpenBot **tidak menggunakan WebRTC Video Tracks** (RTP H.264/VP8/VP9) untuk feed browser, melainkan menggunakan protokol **CDP Screencast berbasis JPEG framing**:

```
+---------------------------------------------------------------------------------+
|                                 BROWSER HOST                                    |
|                                                                                 |
|  [Chromium Renderer]                                                            |
|          | (Page.screencastFrame: base64 JPEG)                                  |
|          v                                                                      |
|  [BrowserCdpEngine] (src/backend/browser-cdp.ts)                                |
|          | - Page.screencastFrameAck                                            |
|          | - Buffer.from(data, "base64")                                        |
|          v                                                                      |
|  [createFramePacer] (src/backend/browser-screencast-pacing.ts)                  |
|          | - Throttle interval: 33ms (~30 FPS cap)                              |
|          v                                                                      |
|  [BrowserViewGateway] (src/main/browser-view-gateway.ts)                        |
|          | - Drop frame jika socket.bufferedAmount > 4 MB                       |
|          | - Binary Framing: encodeBrowserViewFrame(frame)                      |
|          v                                                                      |
+----------+----------------------------------------------------------------------+
           |
           | WebSocket (`/v1/browser/view/sessions/:id/stream`)
           | atau WebRTC DataChannel (Tunnel)
           v
+---------------------------------------------------------------------------------+
|                                REMOTE CLIENT                                    |
|                                                                                 |
|  [createRemoteBrowserView] (packages/team-client/src/browser-view.ts)           |
|          | - decodeBrowserViewFrame                                             |
|          v                                                                      |
|  [BrowserLiveView.tsx] (packages/ui/src/features/browser/BrowserLiveView.tsx)   |
|          | - createImageBitmap(new Blob([jpegBytes], { type: "image/jpeg" }))   |
|          | - HTML5 Canvas: context.drawImage(bitmap, 0, 0, width, height)      |
|          | - Letterbox coordinate tracking & sequence ack                       |
+---------------------------------------------------------------------------------+
```

#### Struktur Binary Framing (`packages/contracts/src/team-protocol/browser-view-v1.ts:322-332`):
Setiap frame video dikemas dalam buffer binary:
```
+---------------+-------------------+------------------+-------------------+--------------------+
| Magic (4 Byte)| Sequence (4 Byte) | Width (2 Byte)   | Height (2 Byte)   | Raw JPEG Payload   |
| "BV01" (0x42  | uint32 (Big-End)  | uint16 (Big-End) | uint16 (Big-End)  | Binary JPEG Data   |
|  0x56 0x30 31)|                   |                  |                   | (variable length)  |
+---------------+-------------------+------------------+-------------------+--------------------+
```
- **Pacing & Backpressure:**
  - `createFramePacer` (`src/backend/browser-screencast-pacing.ts`) mengunci laju maksimum 30 FPS (`SCREENCAST_MINIMUM_FRAME_INTERVAL_MS = 33`). Frame baru yang tiba sebelum timer 33ms menggantikan frame yang sedang di-hold.
  - Jika koneksi jaringan lambat dan buffer soket menumpuk (`client.bufferedAmount > 4 * 1024 * 1024`), frame berikutnya langsung di-drop untuk menjaga transmisi tetap real-time (`src/main/browser-view-gateway.ts:317`).

### 4.2 Interactive Takeover & Input Injection Pipeline
Interaksi mouse, keyboard, dan clipboard ditransmisikan kembali dari remote client ke host melalui pesan JSON:
1. **Letterbox & Koordinat Terkalibrasi:**
   - Klien (`packages/ui/src/features/browser/BrowserLiveView.tsx:236-248`) menghitung letak kursor terhadap rasio aspek frame aktual yang sedang ditampilkan pada canvas (mengabaikan bilah hitam surat/letterbox).
   - Menghasilkan fraksi ternormalisasi `x: [0..1]` dan `y: [0..1]`, serta menyertakan nomor `sequence` dari frame spesifik tersebut.
2. **Coalescing & Gateway Handling (`src/main/browser-view-gateway.ts`):**
   - Untuk mencegah kebanjiran input saat pengguna menggerakkan mouse dengan cepat di atas koneksi berlatensi, gateway menahan pergerakan mouse terakhir (`session.heldMove`) dan hanya mengirimkannya saat tidak ada input lain yang mengantre.
   - Koordinat dikalibrasi ulang ke ukuran piksel fisik: `x = input.x * frame.width`, `y = input.y * frame.height`.
3. **Injeksi CDP di Host (`src/backend/browser-cdp.ts:2380-2468`):**
   - **Mouse Events:** Dipetakan ke CDP `Input.dispatchMouseEvent` (`mousePressed`, `mouseReleased`, `mouseMoved`, `mouseWheel`) dengan penanganan modifier bitmap (Shift, Control, Alt, Meta) dan button mask.
   - **Keyboard Events:** Dipetakan ke CDP `Input.dispatchKeyEvent` (`rawKeyDown`, `keyDown`, `keyUp`, `char`). Khusus tombol shortcut seperti `Ctrl+A` / `Cmd+A`, CDP secara eksplisit menyertakan perintah editing `commands: ["selectAll"]`.
   - **Clipboard Isolation:**
     - Aksi `paste` (`Input.insertText` / `PASTE_EVENT_SCRIPT`) mengeksekusi event paste sintetis langsung pada target DOM tanpa menyentuh clipboard OS host.
     - Aksi `copy` (`BrowserCdpEngine.viewportSelectionText`) mengekstrak teks seleksi via JavaScript DOM dan mengirimkannya kembali ke remote client via pesan WebSocket `copied`, sehingga clipboard pengguna lokal di host tidak tertimpa.

---

## 5. Analisis Kinerja & Footprint di Container VM (`openbot-vm`)

### 5.1 Alokasi Resource & Bottleneck CPU/RAM
Container target beroperasi dengan batasan spesifikasi Incus berikut:
- **vCPU:** 6 core (`limits.cpu=6`)
- **Memory Limit:** 6 GiB (`limits.memory=6GiB`)
- **Process/Thread Limit:** 512 (`limits.processes=512`)
- **Systemd Memory Ceiling:** `MemoryMax=5500M` (tanpa `MemoryHigh`, `OOMPolicy=continue`, `Restart=always`).
- **Runtime Constraints:** `NODE_OPTIONS=--max-old-space-size=2048`, `--renderer-process-limit=3`.

#### Bottleneck 1: CPU Starvation akibat Dual Xvfb + SwiftShader
- Karena tidak ada akselerasi GPU fisik, server menjalankan dua Xvfb server (`OPENBOT_AGENT_DISPLAY` dan `DISPLAY`).
- Chromium berjalan dengan `--disable-gpu-compositing` dan `--enable-unsafe-swiftshader`.
- SwiftShader mengeksekusi shader grafis WebGL dengan mengkompilasinya menggunakan LLVM JIT secara runtime di CPU.
- Situs web modern dengan CSS styling kompleks, animasi SVG, atau canvas visual akan memicu utilisasi 100% pada seluruh 6 vCPU di VM, menaikkan load average di atas 10.0-15.0.

#### Bottleneck 2: Background Throttling Dinonaktifkan (`backgroundThrottling: false`)
Pada `src/backend/browser-host.ts:399`:
```typescript
const BROWSER_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  // ...
  backgroundThrottling: false,
};
```
- **Analisis Dampak:** Chromium secara normal memperlambat timer JavaScript (menjadi 1Hz / 1000ms) dan menonaktifkan `requestAnimationFrame` untuk tab yang tidak aktif guna menghemat siklus CPU.
- OpenBot secara sengaja mematikan background throttling dengan alasan agar aksi agen tidak terhambat saat tab tidak fokus.
- **Konsekuensi Kritis di VM Headless:** Tab yang berjalan di background tetap memproses loop animasi dan interval timer dengan kecepatan penuh. Hingga tab tersebut ditidurkan oleh sweeper (setelah 15 menit melalui `IDLE_TAB_SLEEP_MS`), 3 tab aktif dapat menyerap habis kapasitas CPU CPU-only container.

#### Bottleneck 3: Main Thread Event Loop Blocking & Watchdog Restarts
- **Pipeline Screencast:** Pada 30 FPS, CDP mengirim string Base64 JPEG melalui IPC event loop. Setiap detik, Node.js main thread harus mengalokasikan dan mem-parsing puluhan string Base64 serta mengonversinya menjadi Buffer (`Buffer.from(data, "base64")`).
- Volume alokasi memori sementara ini mencapai 6–10 MB/s per screencast aktif, memicu siklus Minor Garbage Collection V8 yang sangat sering.
- **Dampak Fatal terhadap Liveness Watchdog:**
  - Systemd menjalankan watchdog timer `openbot-watchdog.timer` tiap 1 menit yang mengirim permintaan HTTP ke `http://127.0.0.1:28417/`.
  - Jika main thread Node.js OpenBot terblokir (misalnya oleh GC pause panjang, kompilasi regex besar, atau snapshot DOM traversing saat CPU 100%), permintaan HTTP pada port 28417 akan mengalami timeout (>15s).
  - Tiga kali timeout berturut-turut memicu `systemctl restart openbot.service`, memutus paksa seluruh proses agen dan browser yang sedang berjalan.

### 5.2 Pola Alokasi Proses & Risiko cgroup `pids.max` (512 Limit)
Di Linux cgroups v2, parameter `pids.max` menghitung **seluruh entitas task kernel (threads + processes)** yang berada di dalam hierarki cgroup container.

Daftar task tipikal dalam container `openbot-vm`:
1. `systemd` (PID 1) + journald + udevd + dbus: ~15 threads.
2. `dbus-run-session` + `gnome-keyring-daemon`: ~8 threads.
3. Xvfb display agent (`OPENBOT_AGENT_DISPLAY`): ~5 threads.
4. Xvfb display OpenBot (`DISPLAY`): ~5 threads.
5. `openbot-hosted-server` wrapper scripts: ~4 processes.
6. OpenBot Main Process (Node/V8): 30–40 threads (V8 compiler threads, libuv thread pool, Signal client).
7. Chromium GPU Process (SwiftShader): 20–30 threads.
8. Chromium Network/Utility Process: 15–20 threads.
9. OpenBot UI Renderer (`main-window.ts`): ~20 threads.
10. OpenBot WebRTC Bridge Renderer (`team-webrtc.html`): ~20 threads.
11. Tab Renderer Processes (3 tabs aktif): ~75–90 threads (masing-masing 25–30 threads).
12. `cua-driver` Daemon: 15–25 threads (Tokio async runtime worker threads).
13. Sub-proses Agen & Eksternal:
    - MCP Servers (Node/Python CLI): 20–40 threads.
    - Bash command execution, git, ripgrep, compiler: 20–50 processes/threads.

**Total Task Count Terakumulasi:** 270 – 350 tasks dalam kondisi beban moderat.
**Ambang Bahaya:** Ketika agen menjalankan build script (misalnya `npm build`, `cargo`, atau script multi-thread) bersamaan dengan 3 tab browser aktif, jumlah task menembus batas `limits.processes=512`. Akibatnya, perintah shell baru langsung gagal dengan error sistem:
`fork: Resource temporarily unavailable` (EAGAIN), merusak eksekusi task agen.

---

## 6. Temuan Bottleneck Spesifik: CDP Snapshot N+1 Flooding

Pada modul `src/backend/browser-cdp-snapshot.ts:745-755`, ditemukan pola bottleneck round-trip N+1 yang sangat masif:

```typescript
// src/backend/browser-cdp-snapshot.ts:745-755
for (let offset = 0; offset < objectIds.length && results.length < limit; offset += batchSize) {
  const batch = objectIds.slice(offset, offset + batchSize);
  const resolved = yield* Effect.all(
    batch.map((objectId) =>
      Effect.gen(function* () {
        const [description, partialAxTree, visibleTextResult] = yield* Effect.all(
          [
            send("DOM.describeNode", { objectId, depth: 0 }, capture.sessionId),
            send("Accessibility.getPartialAXTree", { objectId, fetchRelatives: false }, capture.sessionId),
            send(
              "Runtime.callFunctionOn",
              // ...
            ),
          ],
          { concurrency: "unbounded" },
        );
        // ...
      }),
    ),
    { concurrency: "unbounded" },
  );
}
```

### Analisis Masalah:
- `MAX_SNAPSHOT_ELEMENTS = 200` dan `batchSize = 200`.
- Untuk setiap candidate node (hingga 200 elemen per batch), fungsi memetakan 3 perintah CDP independen:
  1. `DOM.describeNode`
  2. `Accessibility.getPartialAXTree`
  3. `Runtime.callFunctionOn`
- Walaupun dibungkus dalam `Effect.all` paralel, seluruh 600 perintah CDP ini disalurkan melalui antrean single-channel WebSocket/IPC debugger Electron (`this.#contents.debugger.sendCommand`).
- **Dampak Kinerja:**
  - Chromium renderer process terbebani untuk mengekstrak ratusan partial accessibility tree secara bersamaan.
  - Latensi panggilan snapshot melonjak drastis (dapat memakan waktu 2.5 – 6.0 detik per snapshot pada halaman web kompleks seperti portal e-commerce atau dashboard analitik).
  - Mengonsumsi throughput IPC debugger dan membekukan main thread selama de-serialisasi payload JSON hasil CDP.

---

## 7. Hutang Teknis & Pelanggaran Batas File (OMP Max 700 Lines)

Sistem browser OpenBot memiliki akumulasi hutang teknis modularitas yang sangat besar, melanggar batas keras 700 baris per file:

| File Target | Jumlah Baris Aktual | Rasio terhadap Batas 700 Baris | Tingkat Risiko Arsitektur |
| :--- | :---: | :---: | :--- |
| `src/backend/browser-host.ts` | **4,818 baris** | **6.88x** | Kritis (Monolit ekstrem, high cyclomatic complexity) |
| `src/backend/browser-cdp.ts` | **3,859 baris** | **5.51x** | Kritis (Pencampuran screencast, input, DOM, CDP session) |
| `src/backend/browser-cdp-snapshot.ts` | **968 baris** | **1.38x** | Tinggi (Pencampuran AXTree parsing, DOM filter, batching) |
| `src/main/cua-driver-runtime.ts` | **971 baris** | **1.39x** | Tinggi (Pencampuran socket lifecycle, MCP config, process watch) |

### Dampak Pemeliharaan:
- File `browser-host.ts` menggabungkan manajemen lifecycle Electron views, tab sleep/wake logic, WebRTC policy, proxy routing, dialog interception, consent banner dismissal, dan IPC handling dalam satu modul raksasa.
- Modul ini rentan terhadap race condition memory leaks karena scope lifecycle tab dan Effect fiber saling terikat secara monolitik.

---

## 8. Rekomendasi Teknis & Roadmap Optimasi Headless Server

### Phase 1: Mitigasi Cepat (Immediate Configuration Tuning)
1. **Menaikkan Cgroup Process Limit di Incus VM:**
   - Ubah konfigurasi container VM host:
     ```bash
     incus config set openbot-vm limits.processes=1024
     ```
   - Memberikan headroom yang aman untuk mencegah error `EAGAIN` saat agen menjalankan tool build/compile bersamaan dengan multi-tab browsing.
2. **Optimalisasi Parameter Tab Sleep & Grace Period:**
   - Di `src/backend/browser-host.ts`:
     - Kurangi `IDLE_TAB_SLEEP_MS` dari 15 menit (900.000 ms) menjadi **5 menit (300.000 ms)** di lingkungan server (`OPENBOT_SERVER=1`).
     - Kurangi `MAX_IDLE_AWAKE_TABS` dari 3 menjadi **2 tab**.
     - Hal ini akan segera melepaskan alokasi memori ~300 MB per tab dan menghemat siklus CPU dari tab background yang idle.
3. **Mengaktifkan Throttling Khusus untuk Tab Background Non-Aktif:**
   - Konfigurasikan `backgroundThrottling: true` jika tab tidak sedang dalam proses otomasi aktif (`pendingOperations === 0`), atau gunakan CDP `Emulation.setPageUpkeep` untuk menjeda timer JavaScript pada tab yang tidak sedang menerima input.

### Phase 2: Perbaikan Keamanan & Anti-Detection
1. **Eliminasi WebRTC IP Leak saat Direct Connection:**
   - Ubah `src/backend/browser-host.ts:3559`:
     ```typescript
     // Set disable_non_proxied_udp secara universal atau default_public_interface_only
     contents.setWebRTCIPHandlingPolicy(
       this.#tabProxy(tab) ? "disable_non_proxied_udp" : "default_public_interface_only"
     );
     ```
   - Mencegah kebocoran alamat IP lokal/internal container VM pada semua jenis tab.
2. **WebGL SwiftShader Masking via Preload:**
   - Di `src/preload/browser-page.ts`: Tambahkan proteksi override pada `WebGLRenderingContext.prototype.getParameter`:
     ```typescript
     const UNMASKED_VENDOR_WEBGL = 0x9245;
     const UNMASKED_RENDERER_WEBGL = 0x9246;
     // Mask SwiftShader string menjadi vendor standar (misal Intel / NVIDIA / AMD generic)
     ```
   - Mencegah flag instan bot pada sistem proteksi Cloudflare Turnstile saat running di container tanpa physical GPU.

### Phase 3: Optimasi Kinerja CDP & Remote View
1. **Konsolidasi CDP Snapshot (Fix N+1 Flooding):**
   - Refactor `src/backend/browser-cdp-snapshot.ts`: Gantikan ratusan panggilan terpisah `DOM.describeNode` + `Accessibility.getPartialAXTree` dengan evaluasi tunggal in-page script (`Runtime.evaluate`) yang mengekstrak metadata accessibility dan bounding box secara komprehensif langsung di dalam V8 renderer, mengembalikan hasil serialisasi JSON satu kali.
2. **Offload Base64 Screencast Decoding dari Main Thread:**
   - Alihkan parsing dan framing buffer screencast (`Page.screencastFrame`) ke Worker Thread Node.js terpisah sebelum dikirim ke WebSocket. Hal ini membebaskan event loop proses utama agar liveness watchdog HTTP `127.0.0.1:28417` tidak pernah mengalami hang.

### Phase 4: Refactoring Modularitas (OMP Standard < 700 Lines)
Pecah modul monolitik menjadi module trees terstruktur:
1. `src/backend/browser/` (Module Hierarchy untuk menggantikan `browser-host.ts`):
   - `index.ts` / `facade.ts`: Public API (`BrowserHost` class entrypoint).
   - `types.ts`: Deklarasi tab, state, dan option interfaces.
   - `lifecycle.ts`: Tab creation, sleep/wake, view mounting, background window.
   - `proxy.ts`: Proxy routing, relay lifecycle, WebRTC IP policy.
   - `tools.ts`: Implementasi handler action agen.
2. `src/backend/browser-cdp/` (Module Hierarchy untuk menggantikan `browser-cdp.ts`):
   - `engine.ts`: Core CDP debugger attachment & send wrapper.
   - `screencast.ts`: Screencast framing & pacing.
   - `input.ts`: Synthetic keyboard/mouse/touch dispatching.
   - `dialogs.ts`: Modal alert/confirm/prompt handling.
