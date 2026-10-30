// The organizer's group pages (see TOFU.md, Pages): settings (the group's name, the organizer's name and contact, dues)
// and the import page, whose form is checked or imported by POST /organizer/import and shown again with the file still
// in its box. The export is a plain download link.
import { words } from '../../words';
import type { Organizer } from '../access';
import { html, path } from '../html';
import type { ImportOutcome } from '../importer';
import type { Notice, Shell } from '../page';
import { button, errorSentence, fieldError, hidden, input, linkButton, textarea } from '../ui';
import { MAX_LENGTH } from '../validation';
import type { GroupView } from '../views';
import { exportRestoreHint } from './common';
import { orgShell } from './organizer';

const o = words.org;

export type SettingsValues = { groupName: string; organizerName: string; organizerContact: string; duesLabel: string; duesAmount: string };

export function settingsValuesOf(group: GroupView): SettingsValues {
  return {
    groupName: group.groupName,
    organizerName: group.organizerName,
    organizerContact: group.organizerContact,
    duesLabel: group.duesLabel,
    duesAmount: group.duesAmountCents !== null ? (group.duesAmountCents / 100).toFixed(2) : ''
  };
}

export function settingsValuesFrom(form: URLSearchParams): SettingsValues {
  const get = (name: string) => form.get(name) ?? '';
  return { groupName: get('groupName'), organizerName: get('organizerName'), organizerContact: get('organizerContact'), duesLabel: get('duesLabel'), duesAmount: get('duesAmount') };
}

export function settingsShell(organizer: Organizer, values: SettingsValues, code: string | null, saved: boolean): Shell {
  const notices: (Notice | null)[] = [saved ? { kind: 'done', body: words.ui.saved } : null, code ? { kind: 'error', body: errorSentence(code) ?? words.formErrors.form } : null];
  return orgShell(
    organizer,
    o.settingsHeading,
    html`<h1>${o.settingsHeading}</h1>
<form method="post" action="${path('/organizer/settings')}" class="stack">
${input({ name: 'groupName', label: o.groupName, hint: o.groupNameHint, value: values.groupName, maxLength: MAX_LENGTH.groupName, error: fieldError(code, 'groupName') })}
${input({ name: 'organizerName', label: o.organizerName, value: values.organizerName, maxLength: MAX_LENGTH.organizerName, autocomplete: 'name', error: fieldError(code, 'organizerName') })}
${input({ name: 'organizerContact', label: o.organizerContact, hint: o.organizerContactHint, value: values.organizerContact, maxLength: MAX_LENGTH.organizerContact, autocomplete: 'email', error: fieldError(code, 'organizerContact'), plain: true })}
<h2>${o.duesHeading}</h2>
${input({ name: 'duesLabel', label: o.duesLabel, hint: o.duesLabelHint, value: values.duesLabel, maxLength: MAX_LENGTH.duesLabel, error: fieldError(code, 'duesLabel') })}
${input({ name: 'duesAmount', label: o.duesAmount, value: values.duesAmount, inputMode: 'decimal', maxLength: 12, error: fieldError(code, 'duesAmount') })}
<p class="hint">${o.paidHint}</p>
${button(words.ui.save)}
</form>
<section class="box">
<h2>${o.passwordHeading}</h2>
<p>${o.passwordLine}</p>
</section>`,
    notices
  );
}

export type ImportPage = {
  organizer: Organizer;
  /** The file as it was sent (or '' on a fresh page). */
  text: string;
  /** The page's request id: importing with it twice imports once. */
  rid: string;
  outcome: ImportOutcome | null;
};

export function importShell(page: ImportPage): Shell {
  const outcome = page.outcome;
  // Once imported: the next step, each sheet the file made, to check and open from its own page.
  const made = outcome?.ok && outcome.sheets && outcome.sheets.length > 0 ? outcome.sheets : null;
  const next = made
    ? html`<p>${o.importNext}</p><div class="actions">${made.map((sheet) => linkButton(path(`/organizer/sheets/${sheet.slug}`), o.importOpenSheet(sheet.title), 'primary'))}</div>`
    : undefined;
  const notices: (Notice | null)[] = [
    outcome?.ok ? { kind: 'done', body: outcome.summary, after: next } : null,
    outcome && !outcome.ok ? { kind: 'error', body: outcome.error } : null
  ];
  return orgShell(
    page.organizer,
    o.importHeading,
    html`<h1>${o.importHeading}</h1>
<p>${o.importLine}</p>
<form method="post" action="${path('/organizer/import')}" class="stack">
${hidden('rid', page.rid)}
${textarea({ name: 'json', id: 'import-json', label: o.importBox, value: page.text, rows: 14 })}
<div class="actions">${button(o.importCheck, 'secondary', { name: 'action', value: 'check' })}${button(o.importApply, 'primary', { name: 'action', value: 'import' })}</div>
</form>
<section class="box">
<h2>${o.exportHeading}</h2>
<p class="hint">${o.exportLine}</p>
<p class="hint">${exportRestoreHint()}</p>
<p><a class="button secondary" href="${path('/organizer/export.json')}">${o.exportAll}</a></p>
</section>`,
    notices
  );
}
