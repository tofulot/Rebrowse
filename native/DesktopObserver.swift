import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func output(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
    return result
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    return attribute(element, name) as? String ?? ""
}

// Classify the control before reading any text. Page inputs are never read.
func region(_ element: AXUIElement) -> String {
    var current: AXUIElement? = element
    var toolbar = false
    var address = false
    for _ in 0..<20 {
        guard let node = current else { break }
        let role = stringAttribute(node, kAXRoleAttribute)
        if role == "AXWebArea" { return "page" }
        if role == "AXToolbar" { toolbar = true }
        let identifier = stringAttribute(node, "AXIdentifier").lowercased()
        let description = stringAttribute(node, kAXDescriptionAttribute).lowercased()
        let title = (role == "AXTextField" || role == "AXComboBox") ? stringAttribute(node, kAXTitleAttribute).lowercased() : ""
        if identifier.contains("omnibox") || identifier.contains("address") || description.contains("address and search bar") || description == "address and search" || title == "address and search bar" {
            address = true
        }
        current = elementAttribute(node, kAXParentAttribute)
    }
    if address { return "address-bar" }
    return toolbar ? "toolbar" : "browser-controls"
}

func selectionLength(_ element: AXUIElement) -> Int {
    guard let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return 0 }
    var range = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return 0 }
    return range.length
}

func bounds(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = attribute(element, kAXPositionAttribute), let sizeValue = attribute(element, kAXSizeAttribute),
          CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point), AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

if CommandLine.arguments.contains("--request-permission") {
    let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    output(["accessibility": trusted])
    exit(0)
}

guard let index = CommandLine.arguments.firstIndex(of: "--pid"), CommandLine.arguments.count > index + 1,
      let pid = Int32(CommandLine.arguments[index + 1]), pid > 0 else {
    output(["status": "error", "message": "Missing browser process identifier"])
    exit(1)
}
let once = CommandLine.arguments.contains("--once")
let inspectFocus = once && CommandLine.arguments.contains("--inspect-focus")
let clipboardEnabled = CommandLine.arguments.contains("--clipboard-context")
let application = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(application, 0.15)
let system = AXUIElementCreateSystemWide()
AXUIElementSetMessagingTimeout(system, 0.15)

func foregroundPID() -> pid_t? {
    // Prefer the live accessibility service. NSWorkspace application state is
    // cached until the main run loop runs (see NSRunningApplication.h).
    if let focusedApp = elementAttribute(system, kAXFocusedApplicationAttribute) {
        var focusedPID: pid_t = 0
        if AXUIElementGetPid(focusedApp, &focusedPID) == .success { return focusedPID }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

if CommandLine.arguments.contains("--read-clipboard") {
    // Passive OS read: do not activate a tab, focus a web page, or touch the
    // user's address-bar selection. Check the browser and clipboard version
    // both before and after resolving text from the pasteboard.
    let board = NSPasteboard.general
    guard let versionIndex = CommandLine.arguments.firstIndex(of: "--clipboard-version"),
          CommandLine.arguments.count > versionIndex + 1,
          let expectedVersion = Int(CommandLine.arguments[versionIndex + 1]),
          foregroundPID() == pid, board.changeCount == expectedVersion else {
        output(["unavailable": true]); exit(0)
    }
    let text = board.string(forType: .string) ?? ""
    guard foregroundPID() == pid, board.changeCount == expectedVersion else {
        output(["unavailable": true]); exit(0)
    }
    output(["text": String(text.prefix(2049))])
    exit(0)
}

// Observe only the three clipboard shortcuts in this browser's controls.
// Never read event.characters or collect other keys or other applications.
var pendingClipboardShortcut: [String: Any]?
var clipboardShortcutSequence = 0
var clipboardMonitor: Any?
if clipboardEnabled && !once {
    clipboardMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
        guard foregroundPID() == pid, AXIsProcessTrusted(), event.modifierFlags.contains(.command),
              !event.modifierFlags.contains(.control), !event.modifierFlags.contains(.option), !event.isARepeat,
              let kind = [UInt16(8): "copy", UInt16(7): "cut", UInt16(9): "paste"][event.keyCode],
              let focused = elementAttribute(application, kAXFocusedUIElementAttribute) else { return }
        let focus = region(focused)
        guard focus == "address-bar" || focus == "toolbar" || focus == "browser-controls" else { return }
        clipboardShortcutSequence += 1
        let shortcut: [String: Any] = ["id": clipboardShortcutSequence, "kind": kind, "target": focus == "address-bar" ? "address-bar" : "browser-controls"]
        // Let Chrome finish its clipboard write before announcing a copy/cut.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            if foregroundPID() == pid { pendingClipboardShortcut = shortcut }
        }
    }
}

repeat {
    autoreleasepool {
        let trusted = AXIsProcessTrusted()
        let frontPID = foregroundPID()
        let active = frontPID == pid
        let otherChrome = frontPID != nil && !active && NSRunningApplication(processIdentifier: frontPID!)?.bundleIdentifier == "com.google.Chrome"
        var sample: [String: Any] = ["time": Int(Date().timeIntervalSince1970 * 1000), "browserPid": Int(pid), "active": active, "accessibility": trusted, "focus": "unknown", "addressSelected": false, "focusAvailable": false, "otherBrowserActive": otherChrome]
        if (active || inspectFocus) && trusted {
            if let focused = elementAttribute(application, kAXFocusedUIElementAttribute) {
                let focusRegion = region(focused)
                sample["focus"] = focusRegion
                sample["focusAvailable"] = true
                if focusRegion == "address-bar" {
                    sample["addressSelected"] = selectionLength(focused) > 0
                    let role = stringAttribute(focused, kAXRoleAttribute)
                    if role == "AXTextField" || role == "AXComboBox", let text = attribute(focused, kAXValueAttribute) as? String {
                        sample["addressText"] = String(text.prefix(2048))
                    }
                }
            }
        }
        // No observations from other applications are emitted.
        if active {
            if clipboardEnabled {
                // Metadata only. Text is read by the browser adapter after
                // checking the active tab and excluding protected fields.
                sample["clipboardVersion"] = NSPasteboard.general.changeCount
                if let shortcut = pendingClipboardShortcut { sample["clipboardShortcut"] = shortcut }
            }
            if let pointer = CGEvent(source: nil)?.location {
                var position: [String: Any] = ["x": Int(pointer.x), "y": Int(pointer.y), "space": "screen", "region": "unknown"]
                if trusted, let window = elementAttribute(application, kAXFocusedWindowAttribute), let frame = bounds(window) {
                    position["x"] = Int(pointer.x - frame.origin.x)
                    position["y"] = Int(pointer.y - frame.origin.y)
                    position["space"] = "browser-window"
                    position["width"] = Int(frame.width)
                    position["height"] = Int(frame.height)
                    if frame.contains(pointer) {
                        var hovered: AXUIElement?
                        if AXUIElementCopyElementAtPosition(application, Float(pointer.x), Float(pointer.y), &hovered) == .success, let hovered {
                            position["region"] = region(hovered)
                        }
                    } else { position["region"] = "outside-window" }
                }
                sample["pointer"] = position
            }
        }
        output(sample)
        pendingClipboardShortcut = nil
    }
    if once { break }
    // Thread.sleep freezes NSWorkspace's cached foreground-app properties.
    // Let AppKit process activation/termination changes between samples.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
} while NSRunningApplication(processIdentifier: pid) != nil
