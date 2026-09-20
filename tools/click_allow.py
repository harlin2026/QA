"""Fast click of simplified-Chinese 「允许」 on the native phone dialog."""
from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
from ctypes import wintypes

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

user32 = ctypes.windll.user32
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_MOVE = 0x0001


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def enable_dpi() -> None:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass


def os_click(x: int, y: int, label: str = "允许") -> None:
    print(f"即将点击：{label} 屏幕({int(x)},{int(y)})", flush=True)
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.2)
    screen_w = max(user32.GetSystemMetrics(0), 1)
    screen_h = max(user32.GetSystemMetrics(1), 1)
    abs_x = int(x * 65535 / screen_w)
    abs_y = int(y * 65535 / screen_h)
    user32.mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE, abs_x, abs_y, 0, 0)
    time.sleep(0.04)
    user32.mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTDOWN, abs_x, abs_y, 0, 0)
    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTUP, abs_x, abs_y, 0, 0)
    print(f"已点击：{label}", flush=True)
    if "允许" in str(label):
        print("CLICKED_ALLOW", flush=True)


def rect_ok(rect) -> bool:
    return 40 <= rect.width() <= 160 and 12 <= rect.height() <= 50


def first_named(kind, name: str, timeout: float = 0.8):
    import uiautomation as auto

    auto.SetGlobalSearchTimeout(timeout)
    if kind == "button":
        ctrl = auto.ButtonControl(Name=name)
    elif kind == "text":
        ctrl = auto.TextControl(Name=name)
    else:
        return None
    return ctrl if ctrl.Exists(timeout, 0) else None


def click_allow() -> bool:
    import uiautomation as auto

    auto.SetGlobalSearchTimeout(0.8)
    allow = first_named("button", "允许", 0.9)
    if allow:
        rect = allow.BoundingRectangle
        print(f"找到按钮「允许」({rect.left},{rect.top})-({rect.right},{rect.bottom})", flush=True)
        if rect_ok(rect):
            os_click((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2, "允许")
            return True
        print("这个「允许」尺寸不像手机号弹窗按钮，跳过", flush=True)

    reject = first_named("button", "拒绝", 0.6) or first_named("text", "拒绝", 0.4)
    if not reject:
        reject = first_named("button", "拒絕", 0.4) or first_named("text", "拒絕", 0.3)
    if reject:
        rect = reject.BoundingRectangle
        print(f"找到「拒绝」({rect.left},{rect.top})-({rect.right},{rect.bottom})", flush=True)
        # 实测：拒绝右缘到允许左缘约 10px，两颗按钮同宽
        x = rect.right + 10 + max(rect.width() // 2, 30)
        y = (rect.top + rect.bottom) // 2
        os_click(x, y, "允许")
        return True
    return False


def main() -> int:
    enable_dpi()
    watchdog = threading.Timer(2.0, lambda: os._exit(2))
    watchdog.daemon = True
    watchdog.start()
    try:
        if click_allow():
            watchdog.cancel()
            return 0
    except Exception as error:
        watchdog.cancel()
        print(f"CLICK_FAIL {error}", flush=True)
        return 1
    watchdog.cancel()
    print("NOT_FOUND", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
