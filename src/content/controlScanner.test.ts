/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { scanUnmappedControls, type ActiveMapSelectors } from './controlScanner';
import { FILLABLE, querySelectorAllDeep } from './deepDom';

if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape(value: string): string {
        return String(value).replace(/([^\w-])/g, '\\$1');
      },
    },
  });
}

function stubVisibleBox(el: Element, size: { width?: number; height?: number } = {}): void {
  const width = size.width ?? 120;
  const height = size.height ?? 24;
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() {
      return this;
    },
  };
  el.getClientRects = () => [rect] as unknown as DOMRectList;
  el.getBoundingClientRect = () => rect as DOMRect;
}

function stubZeroBox(el: Element): void {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this;
    },
  };
  el.getClientRects = () => [] as unknown as DOMRectList;
  el.getBoundingClientRect = () => rect as DOMRect;
}

function stubAllVisible(): void {
  for (const el of querySelectorAllDeep(FILLABLE)) stubVisibleBox(el);
}

function mountShadowRadioGroup(hostId: string, radioId: string, name: string): void {
  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <fieldset>
      <legend>Accepting patients</legend>
      <label>Yes <input id="${radioId}" type="radio" name="${name}" value="yes"></label>
      <label>No <input type="radio" name="${name}" value="no"></label>
    </fieldset>
  `;
  document.body.append(host);
  for (const el of querySelectorAllDeep(FILLABLE, shadow)) stubVisibleBox(el);
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

describe('scanUnmappedControls', () => {
  it('uses associated labels, fieldset legends, nearby captions, and placeholders', () => {
    document.body.innerHTML = `
      <label for="npi">National Provider Identifier</label>
      <input id="npi" name="npi" type="text">
      <fieldset>
        <legend>Practice identity</legend>
        <input id="tax-id" name="taxId" type="text">
      </fieldset>
      <div><span>Group name</span><input id="group-name" type="text"></div>
      <input id="placeholder" type="text" placeholder="Legal group name">
      <label for="start-date">Start date</label><input id="start-date" type="date">
    `;
    stubAllVisible();

    expect(scanUnmappedControls()).toEqual([
      {
        selector: '#npi',
        controlType: 'text',
        label: 'National Provider Identifier',
        name: 'npi',
        id: 'npi',
      },
      {
        selector: '#tax-id',
        controlType: 'text',
        label: 'Practice identity',
        name: 'taxId',
        id: 'tax-id',
      },
      {
        selector: '#group-name',
        controlType: 'text',
        label: 'Group name',
        id: 'group-name',
      },
      {
        selector: '#placeholder',
        controlType: 'text',
        label: 'Legal group name',
        placeholder: 'Legal group name',
        id: 'placeholder',
      },
      {
        selector: '#start-date',
        controlType: 'date',
        label: 'Start date',
        id: 'start-date',
      },
    ]);
  });

  it('scans controls in open shadow roots and includes only safe metadata', () => {
    const host = document.createElement('lh-input');
    host.setAttribute('label', 'CAQH identifier');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="caqh" name="caqhId" type="text" placeholder="CAQH ID">';
    document.body.append(host);
    stubAllVisible();

    expect(scanUnmappedControls()).toEqual([
      {
        selector: '#caqh',
        controlType: 'text',
        label: 'CAQH identifier',
        placeholder: 'CAQH ID',
        name: 'caqhId',
        id: 'caqh',
      },
    ]);
  });

  it('deduplicates one named radio group and keeps same-name groups separate by form', () => {
    document.body.innerHTML = `
      <form id="first">
        <fieldset><legend>Certification type</legend>
          <label>Individual <input id="individual" type="radio" name="certType" value="person"></label>
          <label>Group <input id="group" type="radio" name="certType" value="organization"></label>
        </fieldset>
      </form>
      <form id="second">
        <fieldset><legend>Other certification type</legend>
          <label>Individual <input id="other-individual" type="radio" name="certType" value="person"></label>
          <label>Group <input id="other-group" type="radio" name="certType" value="organization"></label>
        </fieldset>
      </form>
    `;
    stubAllVisible();

    expect(scanUnmappedControls().map((control) => control.selector)).toEqual([
      '#individual',
      '#other-individual',
    ]);
    expect(scanUnmappedControls().map((control) => control.label)).toEqual([
      'Certification type',
      'Other certification type',
    ]);
  });

  it('fails closed when an idless radio name selector spans separate forms', () => {
    document.body.innerHTML = `
      <form><label>Yes <input type="radio" name="same-name" value="yes"></label></form>
      <form><label>No <input type="radio" name="same-name" value="no"></label></form>
    `;
    stubAllVisible();
    expect(scanUnmappedControls()).toEqual([]);
  });

  it('fails closed when duplicate ids or names produce ambiguous selectors across open roots', () => {
    document.body.innerHTML = `
      <input id="duplicate-id" type="text">
      <input id="duplicate-id" type="text">
      <input name="duplicate-name" type="text">
      <input name="duplicate-name" type="text">
    `;
    mountShadowRadioGroup('shadow-a', 'same-shadow-id', 'same-radio-name');
    mountShadowRadioGroup('shadow-b', 'same-shadow-id', 'same-radio-name');
    stubAllVisible();

    expect(scanUnmappedControls()).toEqual([]);
  });

  it('skips controls already reached by active map primary, fallback, or label selectors', () => {
    document.body.innerHTML = `
      <label for="npi">Provider identifier</label><input id="npi" name="npi" type="text">
      <input id="tin" name="tin" type="text">
      <input id="unmapped" name="unmapped" type="text">
    `;
    stubAllVisible();
    const activeMaps: ActiveMapSelectors[] = [
      { selector: '#stale', selectorFallbacks: ['label:Provider identifier'] },
      { selector: 'label:Tax identifier', selectorFallbacks: ['#tin'] },
    ];
    document.querySelector('label[for="tin"]')?.remove();
    const label = document.createElement('label');
    label.htmlFor = 'tin';
    label.textContent = 'Tax identifier';
    document.body.insertBefore(label, document.getElementById('tin'));

    expect(scanUnmappedControls(activeMaps).map((control) => control.selector)).toEqual([
      '#unmapped',
    ]);
  });

  it('skips hidden, zero-size, disabled, read-only, sensitive, and extension-owned controls', () => {
    document.body.innerHTML = `
      <div hidden><input id="hidden" type="text"></div>
      <input id="zero" type="text">
      <input id="disabled" type="text" disabled>
      <fieldset disabled><input id="fieldset-disabled" type="text"></fieldset>
      <input id="readonly" type="text" readonly>
      <input id="password" type="password">
      <input id="file" type="file">
      <input id="submit" type="submit">
      <div id="__minted-panel-pick-overlay"><input id="owned-id" type="text"></div>
      <div class="__mp-private-root"><textarea id="owned-class"></textarea></div>
      <div data-minted-panel-owned><select id="owned-data"><option>Option</option></select></div>
      <input id="visible" type="email">
    `;
    stubAllVisible();
    stubZeroBox(document.getElementById('zero')!);
    document.documentElement.classList.add('__mp-pick-active');

    expect(scanUnmappedControls().map((control) => control.selector)).toEqual(['#visible']);
  });

  it('does not read value, checked, selected, or option value properties', () => {
    document.body.innerHTML = `
      <label for="text">Provider name</label><input id="text" value="secret">
      <label for="check">Accepting</label><input id="check" type="checkbox" checked>
      <label for="radio">Entity type</label><input id="radio" type="radio" name="entity" value="organization" checked>
      <label for="notes">Notes</label><textarea id="notes">existing text</textarea>
      <label for="state">State</label><select id="state"><option value="CA" selected>California</option></select>
    `;
    stubAllVisible();
    const textInput = document.getElementById('text') as HTMLInputElement;
    const checkbox = document.getElementById('check') as HTMLInputElement;
    const radio = document.getElementById('radio') as HTMLInputElement;
    const textarea = document.getElementById('notes') as HTMLTextAreaElement;
    const select = document.getElementById('state') as HTMLSelectElement;
    const option = select.options[0]!;
    const forbidRead = (el: Element, property: string): void => {
      Object.defineProperty(el, property, {
        configurable: true,
        get() {
          throw new Error(`Unexpected ${property} read`);
        },
      });
    };
    forbidRead(textInput, 'value');
    forbidRead(checkbox, 'value');
    forbidRead(checkbox, 'checked');
    forbidRead(radio, 'value');
    forbidRead(radio, 'checked');
    forbidRead(textarea, 'value');
    forbidRead(select, 'value');
    forbidRead(option, 'value');
    forbidRead(option, 'selected');

    expect(scanUnmappedControls().map((control) => control.selector)).toEqual([
      '#text',
      '#check',
      '#radio',
      '#notes',
      '#state',
    ]);
  });
});
