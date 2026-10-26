# 去掉 Duix 帧里烧进去的 duix.com

公开模型包（例如 Lily）的每一帧 JPEG 上都印着白字 `duix.com`。不要用 Flutter 浮层去挡，也不要凭感觉在脸上画一块。先量字的位置，再改两处：打包进 APK 的帧，以及渲染前的 RGB 缓冲。

## 1. 先量，再画

帧在模型 zip 里，文件名是 `*.sij`，内容是普通 JPEG。Lily 是 540×960、RGB。

在多帧上量白字外接框，不要只看第 1 帧。Lily 的第 1、50、100、200、300、400 帧，白字都在 **x 82–181，y 91–108**。

涂抹矩形比字框宽一圈，并取字框上方的背景行来填：

| 量 | Lily（540×960） |
|---|---|
| 左上 | x 70，y 82 |
| 宽高 | 125 × 36（右下不含：x 195，y 118） |
| 取样行 | y 76，也就是矩形顶边再往上 6 像素 |

新模型先按这个办法重测。分辨率不同，或字不在这个位置，下面的数字都要改。字如果压在脸上，不能沿用这块矩形。

Kai（v2.0.1，501 帧，同样 540×960）的白字框和第 1 节相同：第 1、50、100、200、300、501 帧都在 x 82–181、y 91–108。因此用同一个脚本、同一块矩形。第 400 帧在字框之外还有衣服上的近白像素，那不是水印，不要扩大矩形去盖它。改写后上述帧的字框里近白像素为 0，画面中心仍是肤色。

## 2. 改 zip 里的帧

脚本：`scripts/duix/strip-lily-watermark.py`。

它只改 `*.sij`：用 ffmpeg 解成 RGB，把取样行拷进矩形，再以 JPEG 写回，zip 里其余条目原样复制。Lily 的内部顶层目录仍是 `Lily/`。打进 APK 的文件名是小写 `lily.zip`，因为宿主按 `duix/$id.zip` 打开。

```bash
python3 scripts/duix/strip-lily-watermark.py /path/to/Lily.zip app/android/app/src/main/assets/duix/lily.zip
```

脚本里的矩形是写死的 540×960。换模型时先改脚本里的 `SRC_W`、`X0/Y0/X1/Y1`、`SAMPLE_Y`，再跑。

桌面核对：改写后的第 1、50、200、400 帧，原字框里近白像素为 0；未改的包大约 373–382。人脸还在。

## 3. 渲染前再盖一次

`app/android/app/src/main/kotlin/com/aihero/avatar/bontime/duix/WatermarkCover.kt`

`DuixEngine.step` 在 `fileload` / `filerst` 之后、`onVideoFrame` 之前，对这一帧的 RGB 调用 `WatermarkCover.cover`。矩形按 540×960 的比例缩放到实际宽高，取样行同样按比例上移。这样即使某帧没被脚本改到，屏幕上也不出字。

单测：`app/android/app/src/test/kotlin/com/aihero/avatar/bontime/duix/WatermarkCoverTest.kt`。它在取样行填上已知颜色，在字框里放白点，盖完后白点必须变成取样行的颜色。

## 4. 换一个新模型时

1. 解压，确认帧是 `*.sij` 的 JPEG，记下宽高和白字框。
2. 按第 1 节重测矩形。字不在 Lily 那个位置，就改脚本和 `WatermarkCover` 的常量，并改单测。
3. 重打包，再按第 2 节数近白像素。
4. 模型 zip 放进 `app/android/app/src/main/assets/duix/`，文件名小写。zip 内部顶层目录保持模型自带的名字（Lily 是 `Lily/`）。
5. 安装或升级时由 `DuixHost.ensureBundled` 拷出。同一个 `versionCode` 里不会重复拷。
