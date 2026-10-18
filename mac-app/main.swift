// Blip for Mac: a native window around the Blip app that runs on this Mac (http://localhost).
// Adds what a browser tab can't: a Dock icon and badge, Mac notifications, and a real app menu.
import Cocoa
import UserNotifications
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
    WKDownloadDelegate, UNUserNotificationCenterDelegate
{
    var window: NSWindow!
    var webView: WKWebView!
    var extraWindows: [NSWindow] = []
    var retryTimer: Timer?

    /// Where Blip is installed: set at build time in Info.plist, defaulting to ~/Blip.
    let root: String = {
        if let home = Bundle.main.object(forInfoDictionaryKey: "BlipHome") as? String, !home.isEmpty { return home }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Blip").path
    }()

    var port: String {
        guard let env = try? String(contentsOfFile: root + "/.env", encoding: .utf8) else { return "8787" }
        for line in env.split(separator: "\n") where line.hasPrefix("WEB_PORT=") {
            let value = line.dropFirst("WEB_PORT=".count).trimmingCharacters(in: .whitespaces)
            if !value.isEmpty { return value }
        }
        return "8787"
    }

    var base: String { "http://localhost:\(port)" }

    /// The app's access code lives on this Mac, so the Mac app signs itself in.
    var accessCode: String {
        (try? String(contentsOfFile: root + "/data/app-access-code", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(self, name: "blipNotify")
        config.userContentController.add(self, name: "blipBadge")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Blip"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 420, height: 560)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("BlipMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        load()
    }

    func load() {
        retryTimer?.invalidate()
        let code = accessCode.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let path = code.isEmpty ? "/" : "/login?code=\(code)"
        webView.load(URLRequest(url: URL(string: base + path)!))
    }

    /// Shown when the Blip service isn't running; keeps retrying until it is.
    func showOffline() {
        let html = """
            <html><body style="background:#000;color:#a3a3ab;font:15px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
            <div><div style="color:#f5f5f6;font-size:20px;font-weight:600;margin-bottom:8px">Blip isn't running</div>
            Start it in Terminal with <code style="color:#f5f5f6">\(root)/blip.sh install</code><br>Retrying…</div></body></html>
            """
        webView.loadHTMLString(html, baseURL: nil)
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in self?.load() }
    }

    // MARK: navigation, links and downloads

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        // A download or a cancelled load also "fails" the navigation; only a real connection error means offline.
        if (e.domain == "WebKitErrorDomain" && e.code == 102) || e.code == NSURLErrorCancelled { return }
        if webView == self.webView { showOffline() }
    }

    /// macOS can kill the page's process under memory pressure; reload instead of staying blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView == self.webView { load() } else { webView.reload() }
    }

    func isLocal(_ url: URL) -> Bool { url.host == "localhost" || url.host == "127.0.0.1" }

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = action.request.url, ["http", "https", "mailto", "tel"].contains(url.scheme ?? ""), !isLocal(url) {
            NSWorkspace.shared.open(url)  // websites open in your browser
            return decisionHandler(.cancel)
        }
        decisionHandler(action.shouldPerformDownload ? .download : .allow)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if let http = response.response as? HTTPURLResponse,
            let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
            disposition.lowercased().hasPrefix("attachment")
        {
            return decisionHandler(.download)
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var target = folder.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent("\(n)-\(suggestedFilename)")
            n += 1
        }
        completionHandler(target)
    }

    /// target=_blank: file previews open in a new Blip window (same sign-in); websites go to your browser.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if !isLocal(url) {
            NSWorkspace.shared.open(url)
            return nil
        }
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        win.title = url.lastPathComponent
        win.isReleasedWhenClosed = false
        win.contentView = child
        win.center()
        win.makeKeyAndOrderFront(nil)
        extraWindows.append(win)
        // Let a closed preview window (and its page) go, instead of keeping every one alive forever.
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: win, queue: .main) {
            [weak self] note in
            guard let closed = note.object as? NSWindow else { return }
            closed.contentView = nil
            self?.extraWindows.removeAll { $0 === closed }
        }
        return child
    }

    // MARK: file picker, mic, dialogs

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: webView.window ?? window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(origin.host == "localhost" ? .grant : .deny)
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: webView.window ?? window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: webView.window ?? window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // MARK: notifications and Dock badge (posted by the web app through window.webkit.messageHandlers)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "blipBadge":
            let label = message.body as? String ?? ""
            NSApp.dockTile.badgeLabel = label.isEmpty ? nil : label
        case "blipNotify":
            guard !NSApp.isActive, let data = message.body as? [String: Any] else { return }
            let content = UNMutableNotificationContent()
            content.title = data["title"] as? String ?? "Blip"
            content.body = data["body"] as? String ?? ""
            content.sound = (data["silent"] as? Bool ?? false) ? nil : .default  // the bot's Quiet setting
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        default:
            break
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // MARK: app lifecycle and menu

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    @objc func reloadApp() { load() }
    @objc func showMain() { window.makeKeyAndOrderFront(nil) }

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "About Blip", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Blip", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Blip", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(withTitle: "", action: nil, keyEquivalent: "").submenu = appMenu

        // Without an Edit menu, ⌘C / ⌘V / ⌘A don't work in text fields.
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadApp), keyEquivalent: "r").target = self
        main.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Blip", action: #selector(showMain), keyEquivalent: "0").target = self
        main.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = windowMenu

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
