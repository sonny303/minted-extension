/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { scanUnmappedControls } from './controlScanner';
import { NANO_LIMITS } from '../shared/nanoAi';

if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => String(value).replace(/([^\w-])/g, '\\$1') },
  });
}

// Public control metadata observed on 2026-09-27. This fixture has no form or
// provider values and intentionally does not reproduce Holista's application.
const searchField = { id: 'npiNumber', label: 'Search NPI' };
const registrationFields = [
  { id: 'form-office-npi', label: 'NPI' },
  { id: 'form-office-name', label: 'Office Name' },
  { id: 'form-office-contact', label: 'Office Contact' },
  { id: 'form-office-email', label: 'Email' },
  { id: 'form-office-phone', label: 'Phone' },
  { id: 'form-office-fax', label: 'Fax' },
  { id: 'form-office-street-address-1', label: 'Street Address 1' },
  { id: 'form-office-street-address-2', label: 'Street Address 2' },
  { id: 'form-office-city', label: 'City' },
  { id: 'form-office-zip', label: 'Zip Code' },
  { id: 'form-tax-id', label: 'Tax ID' },
  { id: 'form-payee-name', label: 'Payee Name' },
  { id: 'form-contact-person', label: 'Billing Contact' },
  { id: 'form-email', label: 'Billing Email' },
  { id: 'form-phone', label: 'Billing Phone' },
  { id: 'form-fax', label: 'Billing Fax' },
  { id: 'form-line1', label: 'Billing Address Line 1' },
  { id: 'form-line2', label: 'Billing Address Line 2' },
  { id: 'form-city', label: 'Billing City' },
  { id: 'form-zip', label: 'Billing Zip Code' },
  { id: 'form-medical-record-contact', label: 'Medical Record Contact' },
  { id: 'form-medical-record-email', label: 'Medical Record Email' },
  { id: 'form-medical-record-phone', label: 'Medical Record Phone' },
  { id: 'form-medical-record-fax', label: 'Medical Record Fax' },
  { id: 'form-medical-record-portal-url', label: 'Medical Record Portal URL' },
  { id: 'form-contact-name', label: 'Credentialing Contact' },
  { id: 'form-contact-email', label: 'Credentialing Email' },
  { id: 'form-minimum-age', label: 'Minimum Age' },
  { id: 'form-maximum-age', label: 'Maximum Age' },
  { id: 'form-other-information', label: 'Other Information' },
] as const;

function giveVisibleBox(element: Element): void {
  const rect = {
    x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 24,
    width: 120, height: 24, toJSON() { return this; },
  };
  element.getClientRects = () => [rect] as unknown as DOMRectList;
  element.getBoundingClientRect = () => rect as DOMRect;
}

beforeEach(() => {
  const input = ({ id, label }: { id: string; label: string }) =>
    `<label for="${id}">${label}</label><input id="${id}" type="text">`;
  document.body.innerHTML = `
    <form id="npi-search">${input(searchField)}<button type="button">Search</button></form>
    <form id="network-application">
      ${registrationFields.map(input).join('')}
      <input name="addressState" aria-hidden="true" tabindex="-1" style="opacity:0">
      <input name="billingAddressState" aria-hidden="true" tabindex="-1" style="opacity:0">
      <input name="languages" aria-hidden="true" tabindex="-1" style="opacity:0">
      <input name="serviceProvided" aria-hidden="true" tabindex="-1" style="opacity:0">
      <input type="file" aria-label="W-9">
      <input type="file" aria-label="Staff Roster">
      <button type="submit">Submit Application</button>
    </form>
  `;
  for (const field of [searchField, ...registrationFields]) {
    giveVisibleBox(document.getElementById(field.id)!);
  }
  for (const backingInput of document.querySelectorAll('input[aria-hidden="true"]')) {
    // Holista's Material UI backing inputs have a nonzero box despite being
    // visually transparent. Their aria-hidden state must prevent AI capture.
    giveVisibleBox(backingInput);
  }
});

describe('Holista-shaped synthetic form', () => {
  it('offers each visible text field once and excludes dropdown backing and file inputs', () => {
    const scanned = scanUnmappedControls();
    expect(scanned.map((control) => control.selector)).toEqual(
      [searchField, ...registrationFields].map(({ id }) => `#${id}`),
    );
    expect(scanned).toHaveLength(31);
    expect(scanned.length).toBeLessThanOrEqual(NANO_LIMITS.maxControls);
  });

  it('keeps the lookup NPI distinct from the application NPI and removes approved targets', () => {
    const scanned = scanUnmappedControls([{ selector: '#form-office-name' }]);
    expect(scanned.map((control) => control.selector)).toContain('#npiNumber');
    expect(scanned.map((control) => control.selector)).toContain('#form-office-npi');
    expect(scanned.map((control) => control.selector)).not.toContain('#form-office-name');
    expect(scanned).toHaveLength(30);
  });
});
