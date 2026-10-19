// blip-macdata: structured access to the Mac's own Calendar, Reminders and Contacts (EventKit and Contacts),
// so bots read and add events without screenshots and clicking. Built by Blip at startup like blip-input.
// Prints JSON. The first use asks macOS for permission on the Blip Mac (Calendars, Reminders, Contacts).
//
//   status                         permission state, without asking
//   events <from> <to>             events between two dates (ISO, local time ok: 2026-10-20 or 2026-10-20T09:00)
//   add-event <json>               {"title","start","end","calendar"?,"location"?,"notes"?,"allDay"?}
//   reminders                      open reminders
//   add-reminder <json>            {"title","due"?,"list"?,"notes"?}
//   contacts <query>               people matching a name, email or phone
//   delete-event <id>              removes an event made by add-event (used by the access check)
//   delete-reminder <id>           removes a reminder made by add-reminder

import Contacts
import EventKit
import Foundation

let store = EKEventStore()

func out(_ value: Any) {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
func fail(_ message: String) -> Never {
    out(["error": message])
    exit(1)
}

func parseDate(_ s: String) -> Date? {
    if let d = ISO8601DateFormatter().date(from: s) { return d }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
        f.dateFormat = format
        if let d = f.date(from: s) { return d }
    }
    return nil
}
func iso(_ d: Date?) -> Any {
    guard let d else { return NSNull() }
    let f = ISO8601DateFormatter()
    f.timeZone = .current
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: d)
}

func access(_ type: EKEntityType) -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    let done: (Bool, Error?) -> Void = { ok, _ in granted = ok; sem.signal() }
    if #available(macOS 14.0, *) {
        if type == .event { store.requestFullAccessToEvents(completion: done) } else { store.requestFullAccessToReminders(completion: done) }
    } else {
        store.requestAccess(to: type, completion: done)
    }
    _ = sem.wait(timeout: .now() + 120)
    return granted
}
func needAccess(_ type: EKEntityType, _ name: String) {
    // Background runs pass BLIP_NO_PROMPT: never pop a permission dialog nobody is there to answer.
    if ProcessInfo.processInfo.environment["BLIP_NO_PROMPT"] != nil && EKEventStore.authorizationStatus(for: type) == .notDetermined {
        fail("Blip isn't allowed to read \(name) yet. On the Blip Mac: Settings → This Mac → Check Mac access.")
    }
    if !access(type) {
        fail("macOS hasn't given Blip access to \(name). On the Blip Mac: System Settings → Privacy & Security → \(name) → turn on node (or blip-macdata).")
    }
}
func json(_ s: String) -> [String: Any] {
    guard let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { fail("Expected JSON details.") }
    return o
}

let args = CommandLine.arguments.dropFirst().map { $0 }
guard let cmd = args.first else { fail("No command.") }

switch cmd {
case "status":
    func name(_ s: EKAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "not asked yet"
        case .denied, .restricted: return "denied"
        default: return "allowed"
        }
    }
    let contacts = CNContactStore.authorizationStatus(for: .contacts)
    out([
        "calendar": name(EKEventStore.authorizationStatus(for: .event)),
        "reminders": name(EKEventStore.authorizationStatus(for: .reminder)),
        "contacts": contacts == .notDetermined ? "not asked yet" : contacts == .authorized ? "allowed" : "denied",
    ])

case "events":
    guard args.count >= 3, let from = parseDate(args[1]), let to = parseDate(args[2]) else { fail("Usage: events <from> <to>") }
    needAccess(.event, "Calendars")
    let end = args[2].count <= 10 ? to.addingTimeInterval(86_400) : to // a date-only end includes that whole day
    let predicate = store.predicateForEvents(withStart: from, end: end, calendars: nil)
    let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.prefix(200)
    out(events.map { e -> [String: Any] in
        [
            "title": e.title ?? "", "start": iso(e.startDate), "end": iso(e.endDate), "allDay": e.isAllDay,
            "calendar": e.calendar?.title ?? "", "location": e.location ?? "", "notes": String((e.notes ?? "").prefix(500)),
        ]
    })

case "add-event":
    let d = json(args.count > 1 ? args[1] : "")
    guard let title = d["title"] as? String, let start = parseDate(d["start"] as? String ?? "") else { fail("An event needs a title and a start.") }
    needAccess(.event, "Calendars")
    let e = EKEvent(eventStore: store)
    e.title = title
    e.startDate = start
    e.endDate = parseDate(d["end"] as? String ?? "") ?? start.addingTimeInterval(3600)
    e.isAllDay = d["allDay"] as? Bool ?? false
    e.location = d["location"] as? String
    e.notes = d["notes"] as? String
    let wanted = d["calendar"] as? String
    e.calendar = store.calendars(for: .event).first { $0.title == wanted && $0.allowsContentModifications } ?? store.defaultCalendarForNewEvents
    do { try store.save(e, span: .thisEvent) } catch { fail("Couldn't save the event: \(error.localizedDescription)") }
    out(["ok": true, "id": e.eventIdentifier ?? "", "title": title, "start": iso(e.startDate), "calendar": e.calendar?.title ?? ""])

case "reminders":
    needAccess(.reminder, "Reminders")
    let sem = DispatchSemaphore(value: 0)
    var rows: [[String: Any]] = []
    store.fetchReminders(matching: store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)) { found in
        rows = (found ?? []).prefix(200).map { r in
            ["title": r.title ?? "", "due": iso(r.dueDateComponents?.date), "list": r.calendar?.title ?? "", "notes": String((r.notes ?? "").prefix(300))]
        }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 30)
    out(rows)

case "add-reminder":
    let d = json(args.count > 1 ? args[1] : "")
    guard let title = d["title"] as? String else { fail("A reminder needs a title.") }
    needAccess(.reminder, "Reminders")
    let r = EKReminder(eventStore: store)
    r.title = title
    r.notes = d["notes"] as? String
    if let due = parseDate(d["due"] as? String ?? "") {
        r.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
        r.addAlarm(EKAlarm(absoluteDate: due))
    }
    let wanted = d["list"] as? String
    r.calendar = store.calendars(for: .reminder).first { $0.title == wanted } ?? store.defaultCalendarForNewReminders()
    do { try store.save(r, commit: true) } catch { fail("Couldn't save the reminder: \(error.localizedDescription)") }
    out(["ok": true, "id": r.calendarItemIdentifier, "title": title, "list": r.calendar?.title ?? ""])

case "contacts":
    guard args.count >= 2 else { fail("Usage: contacts <query>") }
    let q = args[1]
    let cs = CNContactStore()
    if ProcessInfo.processInfo.environment["BLIP_NO_PROMPT"] != nil && CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
        fail("Blip isn't allowed to read Contacts yet. On the Blip Mac: Settings → This Mac → Check Mac access.")
    }
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    cs.requestAccess(for: .contacts) { granted, _ in ok = granted; sem.signal() }
    _ = sem.wait(timeout: .now() + 120)
    if !ok { fail("macOS hasn't given Blip access to Contacts. On the Blip Mac: System Settings → Privacy & Security → Contacts → turn on node.") }
    let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactOrganizationNameKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
    var found: [CNContact] = []
    if let byName = try? cs.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: q), keysToFetch: keys) { found += byName }
    if q.contains("@"), let byMail = try? cs.unifiedContacts(matching: CNContact.predicateForContacts(matchingEmailAddress: q), keysToFetch: keys) { found += byMail }
    if q.filter(\.isNumber).count >= 6, let byPhone = try? cs.unifiedContacts(matching: CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: q)), keysToFetch: keys) { found += byPhone }
    var seen = Set<String>()
    out(found.filter { seen.insert($0.identifier).inserted }.prefix(20).map { c in
        [
            "name": "\(c.givenName) \(c.familyName)".trimmingCharacters(in: .whitespaces), "organization": c.organizationName,
            "phones": c.phoneNumbers.map { $0.value.stringValue }, "emails": c.emailAddresses.map { String($0.value) },
        ]
    })

case "delete-event":
    guard args.count >= 2 else { fail("Usage: delete-event <id>") }
    needAccess(.event, "Calendars")
    guard let e = store.event(withIdentifier: args[1]) else { fail("No such event.") }
    do { try store.remove(e, span: .thisEvent) } catch { fail("Couldn't delete it: \(error.localizedDescription)") }
    out(["ok": true])

case "delete-reminder":
    guard args.count >= 2 else { fail("Usage: delete-reminder <id>") }
    needAccess(.reminder, "Reminders")
    guard let r = store.calendarItem(withIdentifier: args[1]) as? EKReminder else { fail("No such reminder.") }
    do { try store.remove(r, commit: true) } catch { fail("Couldn't delete it: \(error.localizedDescription)") }
    out(["ok": true])

default:
    fail("Unknown command \(cmd)")
}
