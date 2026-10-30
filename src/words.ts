// Every English sentence the app shows or shares. The group's own words (group name, sheet titles, descriptions) live
// in the database instead. Sentences marked "exact" are quoted by the live check and the delivery runbook: change them
// only together with those.

export const words = {
  appName: 'Sign-up sheet',

  // Answers to any request.
  originRefused: "This form has to be sent from this sheet's own page. Go back, reload the page and try again.", // exact
  busy: 'Busy for a moment. Go back and try again.', // exact
  waking: 'This sheet is waking up. Try again in a minute.', // exact
  failed: 'Something went wrong on our side. Go back and try again.',
  formUnreadable: "This form couldn't be read. Go back, reload the page and try again.",
  formTooBig: "That's more than this form can take. Go back, make it shorter and try again.",
  // A row cap (caps.ts) reached by a member's claim, and by one of the organizer's own writes.
  rowCap: "This sign-up sheet can't take more sign-ups right now, so nothing was saved. Ask the organizer.",
  rowCapOrganizer: (limit: string, what: string) =>
    `This app can hold at most ${limit} ${what}, so nothing was saved. Delete sheets, dates or people you no longer need, then try again.`,
  signInFirst: 'Sign in as the organizer first.', // exact

  throttle: {
    signIn: 'Too many tries. Wait 15 minutes and try again.', // exact
    memberWrite: 'Too many changes from this connection in a few minutes. Wait 10 minutes and try again.', // exact
    setup: 'Too many tries from this connection. Wait an hour and try again.',
    linkMiss: 'Too many links that don\'t work from this connection. Wait 10 minutes and try again.',
    import: 'Too many imports in the last hour. Wait an hour and try again.'
  },

  // What a typed value can be refused for (validation.ts). The pages name the field next to the sentence.
  text: {
    required: 'Please fill this in.',
    tooLong: (max: number) => `That's too long: keep it to ${max} characters.`,
    invalid: "That has characters this app can't keep. Type it again.",
    card: "That looks like a card or bank number. This app never keeps those." // exact
  },

  // The organizer page in each state (access.ts), and setting up and signing in. Tofu's own screens name the steps
  // these sentences ask for: "Keys & settings", "Hide this value after saving" (a switch, turned on) and "Put it online
  // now" (never "deploy"); keep their words when Tofu's change.
  organizer: {
    setupOpen: {
      heading: 'This sign-up sheet has no organizer yet', // exact
      line: 'The first person to set it up becomes its organizer (its admin). Until someone does, anyone who opens this address could.',
      tofuNote: "(Tofu's message calls this making the first account.) If you didn't just copy this app, close this page.",
      button: 'Set up this app as its organizer', // exact
      note: "To sign in from any device, save ORGANIZER_PASSWORD (at least 12 characters) in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again. That also closes this setup for good."
    },
    seatBanner: (until: string) =>
      `You're the organizer on this browser only, until ${until}. To sign in from any device, save ORGANIZER_PASSWORD (at least 12 characters) in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again.`,
    giveUp: 'Give up setup',
    giveUpYes: 'End setup for good',
    heldElsewhere: {
      heading: 'This sign-up sheet already has an organizer', // exact
      line: "It was set up in another browser. To open the organizer page here, save ORGANIZER_PASSWORD (at least 12 characters) in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again. Then come back and type it here."
    },
    // Only the answer to a setup POST that lost the race.
    setupLost: "Someone else pressed Set up first. If that wasn't you, save ORGANIZER_PASSWORD in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again: that locks every other browser out.", // exact
    setupClosed: 'Setup is closed for good: this app has an organizer password. Sign in with it on the organizer page.',
    newLinkShown: 'Here is the new link. Send it to them now: it is shown only once.', // exact
    // The first link made for someone who never had one (imported, or added by the organizer).
    firstLinkShown: 'Here is their private link. Send it to them now: it is shown only once.',
    lockedUnclaimed: "Setup is closed: nobody set up this app in its first 24 hours. To open the organizer page, save ORGANIZER_PASSWORD (at least 12 characters) in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again.",
    lockedExpired: "This browser's setup access has ended. To keep organizing, save ORGANIZER_PASSWORD (at least 12 characters) in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again.",
    lockedShort: "The organizer page is locked: ORGANIZER_PASSWORD is shorter than 12 characters. Save a longer one in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again.",
    lockedRemoved: "The organizer password was removed, so this page is locked. Save ORGANIZER_PASSWORD again (at least 12 characters) in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again.",
    signIn: {
      heading: 'Organizer sign-in', // exact
      field: 'Password',
      button: 'Sign in',
      hint: 'This is the ORGANIZER_PASSWORD saved for this app in Tofu.',
      wrong: "That password isn't right.", // exact
      forgot: "Forgot it? Save a new ORGANIZER_PASSWORD in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again. Sign-ups are kept; every organizer browser is signed out."
    }
  },

  notFound: "This page doesn't exist. Go back to the sheet and try again.",

  // A person's private link and page.
  member: {
    pageTitle: 'Your sign-ups',
    unknownLink: "This link doesn't work. It may have been replaced by a newer one. Ask the organizer for a new link.", // exact
    noCookie: "Open your private link to see your sign-ups. If you just did and you're back here, this browser isn't keeping cookies: open the link in Safari or Chrome.", // exact
    // Below noCookie: where the link already is.
    whereIsLink: 'Your link is in the notes of the calendar event you added, and in any message you sent yourself. Lost it? Ask the organizer for a new one.',
    seeSheet: 'See the sign-up sheet',
    formReused: 'This form was already used. Reload the page and try again.', // exact
    signedUpNoLink: "You're signed up. Ask the organizer for your private link.", // exact
    yourLink: 'Your private link',
    accessCode: 'If a page asks for an access code first, enter it, then open this link again.',
    landedHere: 'Opened your private link and landed here? Open the link again.',
    newLinkConfirm: 'Make a new private link? The old one stops working on every phone.',
    newLinkMade: 'Here is your new private link. The old one no longer works on any phone.',
    // A claim that made a new person while this phone remembers someone else: the phone keeps its own person.
    madeForSomeoneElse: (name: string) => `${name} is signed up. This is their private link: it is shown only once.`,
    sendToThem: 'Send this link to them'
  },

  // The `?e=` codes the routes send back to a form, and their sentences.
  formErrors: {
    closed: 'Sign-ups for this sheet are closed.',
    past: 'This date has passed.',
    gone: 'This place was removed. Pick another one on the sheet.',
    cancelled: 'This date is cancelled. Pick another one on the sheet.',
    note: 'Please fill in the note: this sheet asks for one.',
    // The same on a sheet whose note has a name of its own ("What you'll bring").
    noteLabelled: (label: string) => `Please fill in "${label}": this sheet asks for it.`,
    who: 'Open your private link again, or sign up with your name.',
    person: 'That person is no longer on the list.',
    form: 'This form is out of date. Reload the page and try again.',
    taken: 'That place was just taken. Nothing changed.',
    // A member's own sign-up once the sheet is closed, or its date is cancelled or has started (their page and the server).
    locked: 'This sheet is closed, or the date was cancelled or has started, so this can no longer change here. Ask the organizer.',
    same: "That's the place you already have.",
    changed: 'Something changed on this sheet since you opened it. Nothing was swapped.',
    conflict: 'One of them is already signed up for the other place, so they cannot swap.',
    slug: 'Another sheet already uses that web address. Pick another one.',
    timezone: "The time zone can't change once people have signed up.",
    capacity: (n: number) => `${n} people are confirmed here. Remove someone first, or keep the capacity at ${n} or more.`,
    hasSignups: 'This person still has sign-ups. Remove them first, or use Remove everywhere.',
    deletionChanged: 'Someone signed up or left since you opened this. Here is the new list of people to tell.', // exact
    dateTaken: 'This sheet already has a date on that day at that time.',
    labelTaken: 'This date already has a place with that name. Pick another name.',
    order: 'The last date must be on or after the first.',
    tooMany: "That's more than 60 weeks. Pick a shorter stretch.",
    nobodyPicked: 'Pick someone from the list, or type a new name.'
  },

  // The import (import-format.ts, importer.ts). Every refusal ends with `nothingImported`. Sentences marked "exact" are
  // quoted by the live check and the delivery runbook.
  import: {
    nothingImported: 'Nothing was imported.', // exact
    notFormat: 'This file isn\'t a sign-up sheet file (its "format" must be "signup-sheet/1").', // exact
    notJson: (line: number, column: number) => `This file isn't valid JSON: look at line ${line}, column ${column}.`,
    tooDeep: 'This file is nested more deeply than a sign-up sheet file can be.',
    tooBig: 'This file is bigger than 512 KB.', // exact
    empty: "There's no file here: paste it into the box first.",
    unreadable: "This file couldn't be read: it must be UTF-8 text.",
    // A second press of the import page's button: its first press imported the file. (Reloading this answer would send
    // the same form again; opening the page from the menu gives a new one.)
    repeated: 'This form was already used, so the file was imported only once. To import another file, open Import and export again.',
    weekday: (date: string, actual: string, said: string) => `${date} is a ${actual}, but the file says ${said}.`, // exact
    overCapacity: (slot: string, when: string, capacity: number, people: number) =>
      `${slot} on ${when} has ${capacity} ${capacity === 1 ? 'place' : 'places'}, but the file signs up ${people} people there.`, // exact
    unknownPerson: (key: string) => `A sign-up names the person "${key}", but no person in the file has that key.`, // exact
    unknownSlot: (slot: string, when: string) => `A sign-up names ${slot} on ${when}, but that date has no slot called ${slot}.`, // exact
    exists: (slug: string) =>
      `A sheet called "${slug}" is already here. To replace it, send "replace": true; that only works while nobody has signed up on it through the page.`, // exact
    memberSignups: (slug: string) => `The sheet "${slug}" has sign-ups people made themselves, so it can't be replaced.`, // exact
    timeZone: (name: string) => `"${name}" isn't a time zone this app knows. Use a name like America/Los_Angeles.`, // exact
    unknownField: (path: string, name: string) => `${path}: "${name}" isn't a field this file can have.`, // exact
    fileItself: 'The file',
    field: (path: string, problem: string) => `${path}: ${problem}.`,
    cap: (limit: string, what: string) => `This app can hold at most ${limit} ${what}, and this file would take it past that.`,
    capWhat: { people: 'people', signups: 'sign-ups', sheets: 'sheets', slots: 'places' },
    // What is wrong with one field: the second half of `field`.
    problem: {
      missing: 'is missing',
      text: 'must be text, in quotes',
      boolean: 'must be true or false',
      list: 'must be a list, in square brackets',
      object: 'must be an object, in braces',
      objectOrNull: 'must be an object, in braces, or null',
      wholeNumber: (min: number, max: number) => `must be a whole number from ${min} to ${max}`,
      required: "can't be empty",
      tooLong: (max: number) => `is longer than ${max} characters`,
      invalid: "has characters this app can't keep",
      card: 'looks like a card or bank number, which this app never keeps',
      oneOf: (choices: readonly string[]) => `must be ${choices.map((choice) => `"${choice}"`).join(' or ')}`,
      date: 'must be a real day written like 2026-11-07',
      time: 'must be a 24-hour time written like 09:00',
      timeOrNull: 'must be a 24-hour time written like 09:00, or null for a date with no time',
      endAfterStart: 'must be later than the start',
      endNeedsStart: 'needs a start time as well',
      weekdayWord: (value: string) => `"${value}" isn't a day of the week: write it like Sat or Saturday`,
      slug: 'must be 1 to 40 lowercase letters, digits and dashes, like snacks',
      slugReserved: 'can\'t be "new", which the app\'s own pages use',
      key: 'must be 1 to 80 characters, with no spaces at either end',
      personId: 'must be the number of a person already here',
      rowId: 'must be a whole number above 0',
      sameSlug: (slug: string) => `another sheet in this file is "${slug}" too`,
      sameKey: (key: string) => `another person in this file has the key "${key}"`,
      sameId: 'another person in this file names the same person already here',
      sameDate: (when: string) => `this sheet has another date on ${when}`,
      sameSlot: (label: string) => `this date has another slot called ${label}`,
      sameJsonField: (name: string) => `"${name}" is written twice`,
      tooMany: (max: number, what: string) => `has more than ${max} ${what}`,
      noSuchDate: (when: string) => `this sheet has no date on ${when}`,
      needsStart: (date: string) => `${date} has more than one time on this sheet, so this needs "start"`,
      twice: (key: string, slot: string, when: string) => `"${key}" is signed up for ${slot} on ${when} more than once`,
      waitingWithRoom: (slot: string, when: string) => `is "waiting", but ${slot} on ${when} still has a place free`,
      noteRequired: (label: string) => (label ? `this sheet asks every sign-up for "${label}"` : 'this sheet asks every sign-up for a note'),
      keptAsTheyAre: (name: string) =>
        `a person with "id" is someone already here, kept as they are, so it can't also give "${name}"`,
      notHere: (name: string) => `no one here has this id and the name "${name}"`,
      from: 'must be text, or an object whose values are text',
      moment: 'must be a time written like 2026-10-29T19:00:00.000Z',
      momentAhead: "can't be later than now"
    },
    // What the file makes, in one line: `Would make: …` for a check, `Imported: …` once done (importer.ts).
    summary: {
      wouldMake: 'Would make:',
      imported: 'Imported:',
      nothing: 'nothing new',
      separator: ' · ',
      sheets: (n: number, list: string) => `${n} ${n === 1 ? 'sheet' : 'sheets'} (${list})`,
      sheet: (title: string, status: string) => `${title}, ${status}`,
      dates: (n: number, range: string) => `${n} ${n === 1 ? 'date' : 'dates'}${range ? `: ${range}` : ''}`,
      cancelledDates: (n: number) => `${n} cancelled`,
      places: (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`,
      people: (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`,
      signups: (n: number, list: string) => `${n} ${n === 1 ? 'sign-up' : 'sign-ups'}${list ? `: ${list}` : ''}`,
      andMore: (n: number) => `and ${n} more`,
      waiting: 'waiting',
      duesWords: (label: string, amount: string) => `${label}${amount ? ` ${amount}` : ''}`,
      dues: (dues: string) => `dues: ${dues}`,
      noDues: 'no dues',
      groupName: (name: string) => `group name: ${name}`,
      organizer: (name: string) => `organizer: ${name || 'no name'}`,
      // A setting the file changes from what this app has now (a second file into a copy in use, say).
      changesGroupName: (from: string, to: string) => `changes the group name from ${from} to ${to || 'none'} on every sheet`,
      changesOrganizer: (from: string, to: string) => `changes the organizer from ${from} to ${to || 'no name'} on every sheet`,
      // The organizer's contact comes with their name: a file whose organizer has none removes the one saved. Never the
      // contact itself (the live check prints the summary).
      changesOrganizerContact: "changes the organizer's email or phone",
      removesOrganizerContact: "removes the organizer's email or phone",
      turnsDuesOff: (dues: string) => `turns off the dues (${dues}): the paid list is hidden`,
      changesDues: (from: string, to: string) => `changes the dues from ${from} to ${to}`,
      replaces: (list: string, sheets: number, signups: number) =>
        `replaces: ${list}${signups > 0 ? ` and ${sheets === 1 ? 'its' : 'their'} ${signups} ${signups === 1 ? 'sign-up' : 'sign-ups'}` : ''}`,
      keeps: (n: number, list: string) => `${n === 1 ? 'keeps 1 person already here' : `keeps ${n} people already here`}: ${list}`,
      fromExport: (date: string) =>
        `from an export of ${date}: everyone in it is added as a new person (the person numbers in the file are ignored)`,
      noLinks: 'imported people have no private link until you make one'
    },
    // A POST to /organizer/import that is neither JSON nor the import page's form.
    formUnsupported: 'Send the file as JSON (Content-Type: application/json), or paste it into the import page.'
  },

  // The sheet's spreadsheet (csv.ts): its header row, in order, and the words in its cells.
  csv: {
    header: [
      'Date',
      'Weekday',
      'Start',
      'End',
      'Date label',
      'Place',
      'Slot',
      'Status',
      'Name',
      'Contact',
      'Note',
      'Paid',
      'Paid note',
      'Added by',
      'Signed up at',
      'Date cancelled'
    ],
    confirmed: 'Confirmed',
    waiting: (n: number) => `Waiting #${n}`,
    paid: 'Yes',
    paidAmount: (amount: string) => `Yes, ${amount}`,
    unpaid: 'No',
    addedBy: { member: 'Themselves', organizer: 'Organizer', import: 'Import' },
    cancelled: 'Yes'
  },

  // A person's own calendar files and the organizer's weekly reminder (ics.ts). The calendar app decides whether an
  // alert actually shows: a file can only ask for one.
  ics: {
    summary: (slot: string, group: string) => `${slot} · ${group}`,
    cancelledSummary: (summary: string) => `Cancelled: ${summary}`,
    signedUpAs: (name: string) => `You signed up as ${name}.`,
    cancelledLine: 'This date is cancelled, so nothing is needed from you that day. The organizer will let you know if that changes.',
    yourNote: (note: string) => `Your note: ${note}`,
    privateLink: (link: string) => `Change or cancel (your private link, keep it to yourself): ${link}`,
    sheetLink: (link: string) => `Sign-up sheet: ${link}`,
    questions: (name: string, contact: string) => `Questions: ${name}${contact ? `, ${contact}` : ''}`,
    alarmTomorrow: (summary: string) => `Tomorrow: ${summary}`,
    alarmSoon: (summary: string) => `In 2 hours: ${summary}`,
    reminderSummary: "Send this week's sign-up reminder",
    reminderDescription: (link: string) => `Open the organizer page and send this week's reminder to your group: ${link}`,
    noneUpcoming: 'You have no upcoming confirmed sign-ups to add to a calendar.',
    nothingToRemind: 'No open sheet has an upcoming date yet, so there is nothing to remind you about.',
    badReminder: "That isn't a day and time this reminder can use."
  },

  // The texts people send from the app (share.ts), word for word; {link} is the sheet's public address unless a text
  // says it is someone's private link. None of them ever carries a contact, a paid state, dues or another person's link.
  share: {
    invite: (title: string, link: string) => [
      `${title}: pick your date here ${link}`,
      'No account needed. Tap a date, type your name, and keep the link it gives you to change or cancel.'
    ],
    weekSubject: (title: string) => `${title} this week`,
    weekHeading: (group: string, title: string) => (group ? `${group}: ${title}, this week` : `${title}, this week`),
    weekLine: (when: string, slot: string, filled: string, open: string) => `${when}: ${slot}: ${[filled, open].filter(Boolean).join('; ')}`,
    takenOne: 'Taken',
    takenMany: (n: number) => `${n} taken`,
    placesOpen: (n: number) => `${n} ${n === 1 ? 'place' : 'places'} open`,
    weekFooter: (link: string) => `Sign up or change: ${link}`,
    nothingThisWeek: 'Nothing in the next 7 days',
    waitlistOne: (name: string, slot: string, when: string, n: number, title: string, room: string, link: string) =>
      `Hi ${name}, you're #${n} on the waitlist for ${slot} on ${when} (${title}). If a place opens, you move up automatically and I'll let you know.${room ? ` These dates still have room: ${room}.` : ''} The sheet: ${link}`,
    waitlistAll: (title: string, link: string) =>
      `Hi everyone on the waitlist for ${title}: if a place opens, you move up automatically and I'll let you know. The sheet: ${link}`,
    waitlistSubject: (title: string) => `${title}: the waitlist`,
    movedUp: (name: string, slot: string, when: string, title: string, link: string) =>
      `Good news, ${name}: a place opened up, so you're now down for ${slot} on ${when} (${title}). Can't make it? Cancel with your link, or reply to me. The sheet: ${link}`,
    // The same for someone with no private link (imported, or added by the organizer): nothing to cancel with.
    movedUpNoLink: (name: string, slot: string, when: string, title: string, link: string) =>
      `Good news, ${name}: a place opened up, so you're now down for ${slot} on ${when} (${title}). Can't make it? Reply to me. The sheet: ${link}`,
    movedUpInGroup: (name: string, when: string, slot: string, link: string) =>
      `${name}, a place opened for you on ${when} (${slot}), so you're in. Sheet: ${link}`,
    movedUpSubject: (title: string) => `${title}: you're in`,
    noContact: 'No phone or email given. Tell them in the group:',
    // One message for the group about several people who gave none.
    noContactFor: (names: string) => `No phone or email given for ${names}. Tell them in the group:`,
    // The same on a sheet that hides names ("Taken"): the message names them, so it is not for the group.
    noContactNamesHidden: 'No phone or email given, and this sheet hides names. Send this to them yourself, not in the group:',
    deleted: (title: string, slot: string, when: string, link: string) =>
      `Change to ${title}: ${slot} on ${when} is cancelled, so your sign-up there is gone. Sorry! The sheet: ${link}`,
    // A whole sheet deleted: no link, since the sheet's address is gone with it.
    sheetDeleted: (title: string, slot: string, when: string) =>
      `Change to ${title}: the whole sheet is deleted, so your sign-up for ${slot} on ${when} is gone. Sorry!`,
    dateCancelled: (title: string, when: string, link: string) =>
      `Change to ${title}: ${when} is cancelled, so nothing is needed from you that day. If it's in your calendar, delete it there. I'll let you know if that changes. The sheet: ${link}`,
    // A change the organizer made (a move, a swap, a date's new day, time or place): the old and the new date, and what
    // to do with the old one in a calendar. `calendar` is calendarWithLink or calendarNoLink.
    changed: (name: string, slot: string, from: string, to: string, title: string, calendar: string, link: string) =>
      `Hi ${name}, a change on ${title}: you're now down for ${slot} on ${to} instead of ${from}. ${calendar} The sheet: ${link}`,
    // When the old day is no longer known (Needs attention, after the change was made).
    changedNow: (name: string, slot: string, to: string, title: string, calendar: string, link: string) =>
      `Hi ${name}, a change on ${title}: you're now down for ${slot} on ${to}. ${calendar} The sheet: ${link}`,
    calendarWithLink: 'If the old date is in your calendar, delete it, and add the new one from your private link.',
    calendarNoLink: 'If the old date is in your calendar, delete it and add the new one.',
    changedSubject: (title: string) => `${title}: a change for you`,
    newLink: (title: string, link: string) => `Here's your new private link for ${title}. The old one no longer works. Keep it to yourself: ${link}`,
    newLinkSubject: (title: string) => `${title}: your new private link`,
    // The first link made for someone who never had one.
    firstLink: (title: string, link: string) =>
      `Here's your private link for ${title}. Open it to see, change or cancel your sign-ups. Keep it to yourself: ${link}`,
    firstLinkSubject: (title: string) => `${title}: your private link`,
    askGroupToTake: (slot: string, when: string, link: string) => `We can't make it on ${when} (${slot}). Can anyone take our place? Sign up here: ${link}`,
    askGroupToSwap: (slot: string, when: string, organizer: string, link: string) =>
      `Can anyone swap dates with us? We have ${when} (${slot}) and can't make it. If you can, tell ${organizer}: ${link}`,
    tellOrganizer: (organizer: string, slot: string, when: string, title: string, link: string) =>
      `Hi ${organizer}, we can't make it on ${when} (${slot}, ${title}), so we cancelled our place. The sheet: ${link}`,
    theOrganizer: 'the organizer',
    toMyself: (title: string, link: string) =>
      title ? `My private link for ${title} (to change or cancel): ${link}` : `My private sign-up link (to change or cancel): ${link}`,
    // A claim made for someone else: their own link, to send them.
    theirLink: (link: string) => `Your private link for the sign-up sheet: ${link} It's how you change or cancel. Keep it to yourself.`,
    toMyselfSubject: 'My private sign-up link',
    // The organizer's contact buttons for someone on an upcoming date.
    remindOne: (name: string, slot: string, when: string, title: string, link: string) =>
      `Hi ${name}, a reminder: you're down for ${slot} on ${when} (${title}). The sheet: ${link}`,
    remindSubject: (title: string) => `${title}: a reminder`,
    deletedSubject: (title: string) => `${title}: a change`,
    askGroupSubject: (title: string) => `${title}: can anyone take a place?`
  },

  seasonOver: 'This season is over. Thanks, everyone!',

  // --- The pages ---------------------------------------------------------------------------------------------------

  nav: {
    label: 'Main',
    skip: 'Skip to the page',
    mySignups: 'Your sign-ups',
    organizer: 'Organizer home',
    people: 'People',
    settings: 'Settings',
    importExport: 'Import and export',
    signOut: 'Sign out'
  },

  // Buttons and small words every page shares. Copy and Share appear only once the page's script runs.
  ui: {
    copy: 'Copy',
    copied: 'Copied',
    share: 'Share',
    whatsapp: 'WhatsApp',
    sms: 'Text',
    email: 'Email',
    emailEveryone: (n: number) => `Email all ${n} (bcc)`,
    copyHint: 'Press and hold the text to copy it.',
    seeMessage: 'See the message',
    back: 'Back',
    save: 'Save',
    optional: '(optional)',
    saved: 'Saved.',
    error: (field: string, sentence: string) => `${field}: ${sentence}`,
    // The document's title on a page that refuses something, so a screen reader hears that the page changed.
    errorTitle: (title: string) => `Error: ${title}`
  },

  // A field's name in an error sentence (`?e=<field>-<error>`; see ui.ts errorSentence).
  fields: {
    name: 'Name',
    contact: 'Email or phone',
    note: 'Note',
    title: 'Title',
    slug: 'Web address',
    description: 'Description',
    timezone: 'Time zone',
    // Where a date happens. ("Place" is a spot to fill on a date: Take it, "1 place left".)
    place: 'Location',
    names: 'Names',
    noteLabel: 'Note label',
    status: 'Status',
    date: 'Date',
    start: 'Start time',
    end: 'End time',
    label: 'Name',
    dateLabel: 'Label',
    capacity: 'How many people',
    groupName: 'Group name',
    organizerName: 'Your name',
    organizerContact: 'Your email or phone',
    duesLabel: 'Dues',
    duesAmount: 'Dues amount',
    amount: 'Amount',
    every: 'Day of the week',
    from: 'First date',
    until: 'Last date'
  },

  // Field errors without a field of their own.
  fieldErrors: {
    date: 'Type a real date, like 2026-11-07.',
    time: 'Type a time like 09:00 or 18:30.',
    end: 'The end time must be after the start time.',
    timezone: "That isn't a time zone this app knows. Use a name like America/Los_Angeles.",
    capacity: 'Type a whole number from 1 to 500.',
    amount: 'Type an amount in dollars, like 40 or 40.00.',
    slugInvalid: 'Use 1 to 40 lowercase letters, digits and dashes, like snacks.',
    slugReserved: '"new" is used by the app\'s own pages. Pick another web address.',
    choice: 'Pick one of the choices.',
    tooLongHere: "That's too long. Make it shorter."
  },

  home: {
    title: 'Sign-up sheets',
    nothingOpen: 'Nothing is open for sign-up yet.', // exact
    nothingOpenHint: 'When the organizer opens a sheet, it shows here.',
    openSheets: 'Open sign-up sheets',
    next: (when: string) => `Next date: ${when}`,
    noneAhead: 'No dates ahead.'
  },

  // The public sheet.
  sheet: {
    closed: 'Sign-ups are closed.', // exact
    draft: 'Draft: only you can see this sheet. Open it for sign-ups when it looks right.', // exact
    organizerView: 'Manage this sheet',
    takeIt: 'Take it',
    joinWaitlist: 'Join the waitlist',
    youreIn: "You're in",
    youreWaiting: (n: number) => `You're #${n} on the waitlist`,
    taken: 'Taken',
    countTaken: (confirmed: number, capacity: number) => `${confirmed} of ${capacity} taken`,
    countLeft: (n: number) => `${n} ${n === 1 ? 'place' : 'places'} left`,
    countFullWaiting: (n: number) => `Full · ${n} waiting`,
    cancelled: 'Cancelled',
    cancelledLine: 'This date is cancelled.',
    earlier: (n: number) => `Earlier dates (${n})`,
    nextOpen: (slot: string, when: string) => `Next open place: ${slot}, ${when}`,
    placesOpen: (n: number) => `${n} ${n === 1 ? 'place is' : 'places are'} open.`,
    allFull: 'Every place ahead is taken. You can join a waitlist.',
    signedUpAs: (name: string) => `On this phone you're ${name}.`,
    yourPlaces: 'Your places on this sheet:',
    mineCancelled: 'cancelled',
    changeOrCancel: 'Change or cancel',
    noDates: 'No dates yet.',
    organizedBy: (name: string) => `Organizer: ${name}`,
    lostLink: 'Lost your link? Ask the organizer for a new one.', // exact
    organizerSignIn: 'Organizer sign-in',
    makeOne: 'Make one for your group',
    statusWaiting: (n: number) => `waiting #${n}`
  },

  // The claim form.
  claim: {
    heading: (slot: string, when: string) => `${slot}, ${when}`,
    name: 'Your name',
    nameHint: 'For a child, use a family name, like "Frank\'s family".',
    contact: 'Email or phone (optional)',
    contactHint: 'Only the organizer sees this.',
    contactKeep: 'Leave it empty to keep the one you gave before. Only the organizer sees it.',
    note: 'Note (optional)',
    noteHint: 'Everyone can see this, like "Bringing oranges".',
    noteHealth: "Don't include health or allergy details.",
    takenNoteHint: 'Your name stays hidden on this sheet ("Taken"), but everyone sees this.',
    // What shows on the sheet, under the form. `label`: the note's own name on this sheet ("What you'll bring"), or ''.
    privacy: (label: string) =>
      `Your name and ${label ? `what you write in "${label}"` : 'note'} show on the sheet. Your email or phone doesn't.`,
    privacyTaken: (label: string) =>
      `On this sheet your name shows only as "Taken". ${label ? `What you write in "${label}"` : 'Your note'} shows on the sheet; your email or phone doesn't.`,
    // The same in "Sign up someone else", whose fields are about the other person.
    theirName: 'Their name',
    theirContact: 'Their email or phone (optional)',
    theirPrivacy: (label: string) =>
      `Their name and ${label ? `what you write in "${label}"` : 'note'} show on the sheet. Their email or phone doesn't.`,
    theirPrivacyTaken: (label: string) =>
      `On this sheet their name shows only as "Taken". ${label ? `What you write in "${label}"` : 'The note'} shows on the sheet; their email or phone doesn't.`,
    signUp: 'Sign up',
    joinWaitlist: (n: number) => `Join the waitlist (you'd be #${n})`,
    full: 'This place is full.',
    signingUpAs: (name: string) => `Signing up as ${name}.`,
    notYou: 'Not you?',
    someoneElse: 'Sign up someone else',
    someoneElseHint: 'They get their own private link. This phone stays yours.',
    already: "You're already signed up here.",
    backToSheet: 'Back to the sheet',
    honeypot: 'Leave this empty'
  },

  // A person's own pages (/me).
  me: {
    previewTitle: 'Private sign-up link (for one person)',
    confirmedNew: (slot: string, when: string) => `You're in: ${slot}, ${when}.`, // exact
    waitingNew: (n: number) => `This place is full, so you're on the waitlist: #${n}. If a place opens, you move up automatically.`, // exact
    keepLink: "Keep this link. It's how you change or cancel, on any phone. Anyone with it can change your sign-ups, so share it only with your family.", // exact
    copyLink: 'Copy link',
    addCalendar: 'Add to my calendar',
    addGoogle: 'Add to Google Calendar',
    updateCalendar: 'Update my calendar',
    calendarHint: 'The file asks your calendar for a reminder the day before (and 2 hours before, when there is a time). Your calendar app decides how reminders show.',
    googleHint: 'Google Calendar uses your own reminder settings.', // exact
    // After joining a waitlist: how they will hear that they moved up (the app sends nothing).
    waitingHow: "The app doesn't send messages: the organizer tells you if you move up, and this page shows it.",
    addContact: 'Add your email or phone under "Your name and contact" so the organizer can reach you.',
    allCalendar: 'Add all my upcoming sign-ups to my calendar',
    placesHeading: 'Your places',
    confirmed: 'Confirmed',
    waiting: (n: number) => `On the waitlist, #${n}`,
    movedUp: (date: string) => `Moved up from the waitlist on ${date}`,
    changed: (date: string) => `Changed by the organizer on ${date}`,
    dateCancelled: 'This date is cancelled, so nothing is needed from you that day. The organizer will let you know if that changes.',
    // Why a sign-up can no longer change here (a date cancelled says so itself).
    lockedClosed: "Sign-ups for this sheet are closed, so this can't change here. Ask the organizer.",
    lockedStarted: "This date has started, so this can't change here. Ask the organizer.",
    noteLabel: 'Your note',
    move: 'Move',
    cancel: 'Cancel',
    leaveWaitlist: 'Leave the waitlist',
    earlier: (n: number) => `Earlier sign-ups (${n})`,
    none: 'You have no sign-ups right now.',
    detailsHeading: 'Your name and contact',
    contactHint: 'Only you and the organizer see this.',
    sendToMyself: 'Send it to myself',
    sendToMyselfHint: 'Opens your email or messages with the link in it, so you can send it to yourself.',
    newLink: 'Make a new private link',
    newLinkHint: 'If someone else has your link, make a new one. The old one stops working on every phone.',
    makeNewLink: 'Make a new link',
    keepMine: 'Keep my link',
    forget: 'Forget me on this phone',
    forgetHint: 'For a shared phone: this browser stops remembering you. Your sign-ups stay, and your link still works.',
    shareSheet: 'Invite others to this sheet',
    saved: 'Saved.',
    cancelled: 'Cancelled.',
    cancelledUp: 'Cancelled. The first person on the waitlist moved up into your place.',
    pickAnother: 'Pick another date on the sheet',
    moved: 'Moved. If this date was in your calendar, add it again to update it.',
    askGroupHeading: 'Nobody was waiting for that place.',
    askGroupLine: 'Ask the group whether someone can take it:',
    tellOrganizerLine: 'And let the organizer know:',
    cancelQuestion: (slot: string, when: string) => `Cancel ${slot} on ${when}? If someone is waiting, they move up.`, // exact
    leaveQuestion: (slot: string, when: string) => `Leave the waitlist for ${slot} on ${when}?`,
    yesCancel: 'Yes, cancel', // exact
    keepIt: 'Keep it', // exact
    swapInstead: 'Would you rather swap? Ask the group:',
    moveHeading: (slot: string, when: string) => `Move ${slot}, ${when}`,
    moveHint: 'Places on this sheet with room. Your note moves with you.',
    moveLegend: 'Places with room',
    moveHere: 'Move here',
    noRoom: 'No other place on this sheet has room right now.',
    questions: (name: string) => `Questions? Ask ${name}:`,
    otherSignups: 'Your sign-ups',
    // The titles of a person's own confirmation pages (they name nobody).
    cancelTitle: 'Cancel a sign-up',
    moveTitle: 'Move a sign-up',
    newLinkTitle: 'Make a new private link'
  },

  // The organizer's pages.
  org: {
    title: 'Organizer',
    // The dashboard.
    heading: 'Your sign-up sheets',
    attention: 'Needs attention',
    calm: 'Nothing needs your attention right now.',
    movedUp: (name: string) => `${name} moved up from the waitlist`,
    changed: (name: string) => `${name}'s place changed`,
    soon: 'Soon',
    toldThem: 'Told them',
    undo: 'Undo',
    toldDone: (name: string) => `Marked ${name} as told.`,
    waitingOn: (n: number, title: string) => `${n} waiting on ${title}`,
    messageWaitlist: 'Message the waitlist',
    openSoon: 'Open places in the next 7 days',
    unpaid: (n: number) => `${n} unpaid`, // exact
    weekReminder: "Send this week's reminder",
    comingUp: 'Coming up',
    nobodyYet: 'Nobody yet',
    openLeft: (n: number) => `${n} open`,
    sheets: 'Sheets',
    noSheets: 'No sheets yet. Make one, or import a file.',
    newSheet: 'New sheet',
    statusWords: { draft: 'Draft', open: 'Open', closed: 'Closed' },
    unlisted: 'Not on the home page',
    filled: (filled: number, total: number) => `${filled} of ${total} places filled`,
    dateCount: (n: number) => `${n} ${n === 1 ? 'date' : 'dates'} ahead`,
    invite: 'Invite your group',
    inviteHint: 'Two lines for the group chat, with the link to the sheet.',
    remindWeekly: 'Remind me each week',
    remindHint: "A repeating event for your own calendar, until the last date, to send this week's reminder. The app itself sends nothing.",
    remindDay: 'Day',
    remindTime: 'Time',
    remindButton: 'Download the reminder',
    exportAll: 'Export everything (JSON)',
    importFile: 'Import a file',
    deleted: 'Deleted.',
    // After removing someone: how many waiting people moved up into the places they left (marked "Moved up: tell them").
    removedUp: (n: number) =>
      n === 0 ? 'Removed.' : n === 1 ? 'Removed. The first person waiting moved up: tell them.' : `Removed. ${n} people waiting moved up: tell them.`,
    tellOnHome: 'Who to tell is on Organizer home.',
    // One sheet.
    publicPage: 'Public page',
    statusHeading: 'Status',
    statusHint: {
      draft: 'Only you can see it.',
      open: 'Anyone with the link can sign up.',
      closed: 'People can see it but cannot sign up or change.'
    },
    makeDraft: 'Back to draft',
    makeOpen: 'Open for sign-ups',
    makeClosed: 'Close sign-ups',
    shareWeek: "This week's reminder",
    csv: 'Download a spreadsheet (CSV)',
    addDate: 'Add a date',
    addDateButton: 'Add the date',
    withSlots: 'Give it the same places as the latest date',
    bulkLink: 'Add a date every week',
    addSlotEvery: 'Add a place to every date',
    addSlotEveryHint: "Adds it to every date from today on that doesn't have a place with this name yet.",
    addSlotEveryButton: 'Add to every date',
    editSheet: 'Edit the sheet',
    deleteSheet: 'Delete this sheet',
    // A date's and a place's changes, folded under one button each.
    changeDate: 'Change this date',
    changeSlot: 'Change this place',
    editDate: 'Edit date',
    addSlot: 'Add a place',
    cancelDate: 'Cancel this date',
    uncancelDate: 'Undo the cancel',
    deleteDate: 'Delete date',
    editSlot: 'Edit place',
    deleteSlot: 'Delete place',
    addSomeone: 'Add someone',
    change: 'Change',
    remove: 'Remove',
    removeOneQuestion: (name: string, slot: string, when: string) => `Remove ${name} from ${slot}, ${when}?`,
    removeOneLine: 'The first person waiting, if anyone is, moves up into the place.',
    removeOneTitle: 'Remove a sign-up',
    moveTo: 'Move',
    swap: 'Swap',
    noSlots: 'No places on this date yet.',
    noDates: 'No dates yet. Add the first one below.',
    earlier: (n: number) => `Earlier dates (${n})`,
    addedBy: { member: 'signed up themselves', organizer: 'added by you', import: 'imported' },
    signedUpOn: (when: string) => `on ${when}`,
    manyPlaces: (n: number) => `${n} places on this sheet`,
    noLink: 'No private link yet',
    waitingNumber: (n: number) => `Waiting #${n}`,
    cancelledTell: (when: string) => `${when} is cancelled. Tell the people on it:`,
    changedTell: 'Tell them about the change:',
    nobodyOn: 'Nobody is signed up on it.',
    // Sheet form (new and edit).
    newSheetHeading: 'New sheet',
    sheetTitle: 'Title',
    slug: 'Web address',
    slugHint: 'Lowercase letters, digits and dashes. The sheet will be at /s/ and this. It cannot change later.',
    description: 'Description (optional)',
    timezone: 'Time zone',
    otherTimezone: 'Other time zone (only with Other)',
    otherTimezoneHint: 'A name like America/Puerto_Rico.',
    place: 'Location (optional)',
    namesLegend: 'Names on the public sheet',
    namesFull: 'Show names',
    namesTaken: 'Show only "Taken"',
    noteLabel: 'What to call the note (optional)',
    noteLabelHint: 'Like "What you\'ll bring". Empty means "Note".',
    noteRequired: 'Everyone must fill in the note',
    listed: 'Show it on the home page when it is open',
    startAs: 'Start as',
    create: 'Make the sheet',
    saveChanges: 'Save changes',
    timezoneLocked: "The time zone can't change once people have signed up.",
    // Dates and places.
    dateLabel: 'Date (2026-11-07)',
    startLabel: 'Start (optional)',
    endLabel: 'End (optional)',
    dateNameLabel: 'Label (optional)',
    dateNameHint: 'Like "vs Eagles" or "Away game".',
    datePlaceHint: "Leave empty to use the sheet's location.",
    editDateHeading: (when: string) => `Edit ${when}`,
    editDateWarning: 'Changing the day, time or location lists everyone on this date for you to tell.',
    addSlotHeading: (when: string) => `Add a place to ${when}`,
    slotLabel: 'Name',
    slotLabelHint: 'Like "Snacks" or "Driver".',
    slotDescription: 'Description (optional)',
    capacity: 'How many people',
    editSlotHeading: (slot: string, when: string) => `Edit ${slot}, ${when}`,
    capacityHint: 'More places move people up from the waitlist.',
    // Bulk dates.
    bulkHeading: 'Add a date every week',
    bulkHint: 'Every week on the same day, from the first date to the last. Dates already on the sheet are skipped.',
    bulkFrom: 'First date (2026-11-07)',
    bulkUntil: 'Last date',
    bulkPreview: 'Show the dates',
    bulkWill: (n: number) => `${n === 1 ? 'This date' : `These ${n} dates`} will be added:`,
    bulkAlready: (n: number) => `${n} already on the sheet, skipped.`,
    bulkAdd: (n: number) => `Add ${n === 1 ? 'the date' : `the ${n} dates`}`,
    bulkNone: 'Every one of these dates is already on the sheet.',
    bulkTooMany: (max: number) => `That's more than ${max} weeks. Pick a shorter stretch.`,
    bulkOrder: 'The last date must be on or after the first.',
    bulkAdded: (n: number) => `Added ${n} ${n === 1 ? 'date' : 'dates'}.`,
    // Adding, moving and swapping people.
    addHeading: (slot: string, when: string) => `Add someone to ${slot}, ${when}`,
    fromRoster: 'Someone already on the list',
    pickPerson: 'Pick a person',
    orNew: 'Or someone new',
    newName: 'Name',
    addThem: 'Add them',
    addFull: (n: number) => `This place is full: they join the waitlist as #${n}.`,
    added: 'Added.',
    // The move and swap pages' document titles, which name nobody; their headings name the person.
    moveTitle: 'Move a sign-up',
    swapTitle: 'Swap places',
    moveHeading: (name: string) => `Move ${name}`,
    moveHint: "Places with room on this sheet. They're listed to tell, with a ready message.",
    moveHere: 'Move here',
    noRoom: 'No other place on this sheet has room.',
    swapHeading: (name: string, slot: string, when: string) => `Swap ${name} (${slot}, ${when}) with`,
    swapHint: 'They trade places and keep their notes. Both are listed to tell.',
    swapWith: 'Swap',
    noSwap: 'Nobody confirmed on another place of this sheet can swap.',
    // Confirmations.
    deleteSheetQuestion: (title: string) => `Delete ${title} with all its dates and sign-ups?`,
    deleteDateQuestion: (when: string) => `Delete ${when} with its places and sign-ups?`,
    // Under a date's delete question, while the date is ahead and not cancelled.
    deleteDateOrCancel: 'Rained out or put off? Cancel the date instead: people stay on it, nobody else can sign up, and you can undo it.',
    deleteSlotQuestion: (slot: string, when: string) => `Delete ${slot} on ${when} with its sign-ups?`,
    cancelDateQuestion: (when: string) => `Cancel ${when}?`,
    cancelDateLine: 'People stay on it, so you can move them; nobody can sign up for it. You can undo this.',
    tellThese: (n: number) => `${n === 1 ? '1 person is' : `${n} people are`} signed up. Tell them:`,
    nobody: 'Nobody is signed up here.',
    yesDelete: 'Yes, delete',
    yesCancelDate: 'Yes, cancel the date',
    keepIt: 'Keep it',
    // People.
    peopleHeading: 'People',
    addPerson: 'Add a person',
    addPersonHint: 'They get no private link until you make one.',
    onlyUnpaid: 'Show only unpaid',
    showEveryone: 'Show everyone',
    linkMade: (date: string) => `Link made ${date}`,
    sameName: 'Same name as another person',
    signupCount: (n: number) => `${n} ${n === 1 ? 'sign-up' : 'sign-ups'}`,
    paid: 'Paid',
    notPaid: 'Not paid',
    paidHint: "Only you see this. The app doesn't take payments.", // exact
    paidAmount: 'Amount (optional)',
    paidNote: 'Note (optional)',
    paidSave: 'Save paid',
    // On the unpaid list: one tap per person, keeping their amount and note.
    markPaid: 'Mark paid',
    markedPaid: (name: string) => `Marked ${name} paid.`,
    noPeople: 'Nobody yet. People appear here when they sign up, or when you add them.',
    noUnpaid: 'Everyone has paid.',
    personHeading: 'Person',
    personDetails: 'Name and contact',
    personSignups: 'Sign-ups',
    personNone: 'No sign-ups.',
    newLink: 'Make a new private link',
    linkHeading: 'Private link',
    linkFor: (name: string) => `${name}'s private link`,
    newLinkQuestion: (name: string) => `Make a new link for ${name}? Their old link stops working.`, // exact
    newLinkYes: 'Make the link',
    // For someone who never had a link (imported, or added by the organizer): nothing old stops working.
    firstLink: 'Make their private link',
    firstLinkQuestion: (name: string) => `Make a private link for ${name}? They use it to see, change or cancel their sign-ups.`,
    notNow: 'Not now',
    newLinkTo: (name: string) => `Send it to ${name}:`,
    newLinkNoContact: 'No phone or email saved for them. Copy the link and send it to them yourself, not to the group.',
    newLinkMessage: 'The message to send them:',
    // On a page that shows someone else's link (the organizer's for them, or a claim made for them from another phone):
    // it is theirs, not the reader's.
    linkAccessCode: "If their phone asks for an access code first, they enter it, then open this link again. Don't open it on your own phone: this app would then take you for them.",
    backToPerson: (name: string) => `Back to ${name}`,
    deletePerson: 'Delete from the list',
    deletePersonHint: 'Only someone with no sign-ups can be deleted.',
    removeEverywhere: 'Remove from every place',
    removeQuestion: (name: string) => `Remove ${name} from every place, and from the list?`,
    removeLine: 'People waiting move up into the confirmed places this frees, except on a date that is cancelled or has started.',
    removeYes: 'Yes, remove',
    // Settings.
    settingsHeading: 'Settings',
    groupName: 'Group name',
    groupNameHint: 'Shown at the top of every sheet.',
    organizerName: 'Your name (shown on the sheet)',
    organizerContact: 'Your email or phone (optional)',
    organizerContactHint: 'People see it only on their own private page and in their calendar files, never on the public sheet.',
    duesHeading: 'Dues',
    duesLabel: 'What the dues are for (optional)',
    duesLabelHint: 'Like "Season dues". Leave empty for no dues and no paid list.',
    duesAmount: 'Amount in dollars (optional)',
    passwordHeading: 'Organizer password',
    passwordLine:
      "To change it, save a new ORGANIZER_PASSWORD in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again. Sign-ups stay; every organizer browser is signed out.",
    // Import.
    importHeading: 'Import a file',
    importLine: 'Paste a file exported from a sign-up sheet, or one made for you. Check it first: nothing changes until you press Import it.',
    importBox: 'The file',
    importCheck: 'Check this file',
    importApply: 'Import it',
    // After an import: each sheet it made, to check and open.
    importNext: 'Next: check each sheet on its page. A draft opens for sign-ups from there.',
    importOpenSheet: (title: string) => `Go to ${title}`,
    exportHeading: 'Export',
    exportLine: 'Everything in this app as one file: sheets, dates, people with their contacts and paid state. Private links are never in it.',
    exportRestoreShort: 'Importing it into a new sign-up sheet app brings it all back except private links.',
    exportRestore: (kb: number, people: number, sheets: number, dates: number, signups: number) =>
      `Importing the file into a new sign-up sheet app brings it all back except private links. One import takes at most ${kb} KB, ${people} people, ${sheets} sheets of up to ${dates} dates each and ${signups.toLocaleString('en-US')} sign-ups, so a bigger app's file can't be imported in one go.`,
    // Share pages.
    weekHeading: "This week's reminder",
    weekEmailAll: 'Email it to everyone on this sheet who gave an email address (bcc):',
    waitlistHeading: 'Message the waitlist',
    waitlistAll: 'To everyone waiting',
    waitlistEach: 'To each person',
    waitlistNone: 'Nobody is waiting on this sheet.',
    toPerson: (name: string) => `To ${name}`,
    // Words the sheet's own page needs besides the ones above.
    listedLegend: 'On the home page',
    listedYes: 'Show it on the home page while it is open',
    listedNo: 'Keep it off the home page (only people with its link find it)',
    statusLegend: 'Start as',
    waitlist: 'Waitlist',
    movedUpTag: 'Moved up: tell them',
    changedTag: 'Changed: tell them',
    noteLine: (label: string, note: string) => `${label}: ${note}`,
    backToSheet: 'Back to the sheet',
    shareHeading: 'Share',
    nothingThisWeek: 'Nothing in the next 7 days',
    dates: 'Dates',
    sheetSettings: 'The sheet',
    sheetSettingsHint: 'Its title, description, time zone, location, how names show, and the note.',
    bulkEvery: (weekday: string) => `Every ${weekday}`,
    addPick: 'Pick someone already on the list, or type a new name.'
  },

  // A state's sentence for the organizer page.
  access: {
    seatGiveUpHint:
      'Ends setup for good, on every browser, this one included. After that, only ORGANIZER_PASSWORD saved in Tofu opens the organizer page. Sheets and sign-ups stay.',
    // When the seat ends, in the first sheet's time zone by its name ("Pacific"), or in UTC before there is a sheet.
    seatUntil: (when: string, zone: string | null) => (zone ? `${when} ${zone} time` : `${when} UTC`)
  },

  // Calendar words for dates and times (time.ts).
  calendar: {
    weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    weekdaysLong: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    monthsLong: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  },

  // The time zones the sheet form offers, by IANA name, plus "Other".
  timeZones: {
    'America/New_York': 'Eastern',
    'America/Chicago': 'Central',
    'America/Denver': 'Mountain',
    'America/Phoenix': 'Arizona',
    'America/Los_Angeles': 'Pacific',
    'America/Anchorage': 'Alaska',
    'Pacific/Honolulu': 'Hawaii',
    other: 'Other'
  }
} as const;
