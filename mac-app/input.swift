// blip-input: a tiny always-running helper that turns remote-control commands into real mouse and keyboard
// events (CoreGraphics), with no process start per click. Built by ./blip.sh; Blip falls back to cliclick
// without it. Reads one command per line on stdin; coordinates are normalized (0..1) across the main display.
//
//   m x y          move (drags if a button is held)
//   d l|r x y      button down          u l|r x y   button up
//   c l|r n x y    click n times (1 = click, 2 = double-click)
//   w dx dy        scroll by pixels (positive dy scrolls up)
//   t <base64>     type UTF-8 text (any language, emoji)
//   k combo        key combo, e.g. cmd+shift+4, return, arrow-left
//   p              prints "pong" (health check)

import CoreGraphics
import Foundation
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)
let source = CGEventSource(stateID: .hidSystemState)
var held: CGMouseButton? = nil

func screenPoint(_ nx: Double, _ ny: Double) -> CGPoint {
    let b = CGDisplayBounds(CGMainDisplayID())
    let x = min(1, max(0, nx)), y = min(1, max(0, ny))
    return CGPoint(x: b.origin.x + x * (b.width - 1), y: b.origin.y + y * (b.height - 1))
}

func mouse(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) {
    guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: clicks)
    e.post(tap: .cghidEventTap)
}

func button(_ s: Substring) -> CGMouseButton { s == "r" ? .right : .left }
func downType(_ b: CGMouseButton) -> CGEventType { b == .right ? .rightMouseDown : .leftMouseDown }
func upType(_ b: CGMouseButton) -> CGEventType { b == .right ? .rightMouseUp : .leftMouseUp }

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "esc": 53, "escape": 53,
    "fwd-delete": 117, "home": 115, "end": 119, "page-up": 116, "page-down": 121,
    "arrow-left": 123, "arrow-right": 124, "arrow-down": 125, "arrow-up": 126,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111,
]
let modifierFlags: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "option": .maskAlternate,
    "opt": .maskAlternate, "ctrl": .maskControl, "control": .maskControl, "fn": .maskSecondaryFn,
]

func pressCombo(_ combo: String) {
    var flags: CGEventFlags = []
    var key: CGKeyCode? = nil
    for part in combo.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        if let f = modifierFlags[part] { flags.insert(f) } else { key = keyCodes[part] }
    }
    guard let code = key else { return }
    for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
        e.flags = flags
        e.post(tap: .cghidEventTap)
    }
}

func typeText(_ text: String) {
    // Newlines press Return; everything else is sent as Unicode in small chunks (works for any language).
    for (i, line) in text.components(separatedBy: "\n").enumerated() {
        if i > 0 { pressCombo("return") }
        let units = Array(line.utf16)
        var start = 0
        while start < units.count {
            let chunk = Array(units[start..<min(start + 16, units.count)])
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                e.post(tap: .cghidEventTap)
            }
            start += 16
            usleep(2000)
        }
    }
}

let b = CGDisplayBounds(CGMainDisplayID())
print("ready \(AXIsProcessTrusted() ? 1 : 0) \(Int(b.width)) \(Int(b.height))")

while let line = readLine() {
    let p = line.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true)
    guard let cmd = p.first else { continue }
    let num = { (i: Int) -> Double in i < p.count ? Double(p[i]) ?? 0 : 0 }
    switch cmd {
    case "m":
        let at = screenPoint(num(1), num(2))
        if let h = held { mouse(h == .right ? .rightMouseDragged : .leftMouseDragged, at, h) } else { mouse(.mouseMoved, at, .left) }
    case "d":
        let bt = button(p.count > 1 ? p[1] : "l")
        let at = screenPoint(num(2), num(3))
        mouse(.mouseMoved, at, bt)
        mouse(downType(bt), at, bt)
        held = bt
    case "u":
        let bt = button(p.count > 1 ? p[1] : "l")
        mouse(upType(bt), screenPoint(num(2), num(3)), bt)
        held = nil
    case "c":
        let bt = button(p.count > 1 ? p[1] : "l")
        let n = max(1, min(3, Int(num(2))))
        let at = screenPoint(num(3), num(4))
        mouse(.mouseMoved, at, bt)
        for i in 1...n {
            mouse(downType(bt), at, bt, clicks: Int64(i))
            mouse(upType(bt), at, bt, clicks: Int64(i))
        }
    case "w":
        let dy = Int32(max(-3000, min(3000, num(2)))), dx = Int32(max(-3000, min(3000, num(1))))
        if let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            e.post(tap: .cghidEventTap)
        }
    case "t":
        if p.count > 1, let data = Data(base64Encoded: String(p[1])), let text = String(data: data, encoding: .utf8) { typeText(text) }
    case "k":
        if p.count > 1 { pressCombo(String(p[1])) }
    case "p":
        print("pong")
    default:
        break
    }
}
