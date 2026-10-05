import { describe, expect, it } from 'vitest';
import { createEmptyProfile, formatFullPhone, parsePhoneNumberParts } from '../../src/core/profile';
import { buildKnowledgeBundle } from '../../src/core/knowledge';
import { aliasKnowledgeIds } from '../../src/core/retrieval';

describe('name and phone separation', () => {
  it('parses phone numbers with country codes and extensions correctly', () => {
    const p1 = parsePhoneNumberParts('+1 555-0100 ext 123');
    expect(p1.countryCode).toBe('+1');
    expect(p1.number).toBe('555-0100');
    expect(p1.extension).toBe('123');

    const p2 = parsePhoneNumberParts('+91 9876543210');
    expect(p2.countryCode).toBe('+91');
    expect(p2.number).toBe('9876543210');
    expect(p2.extension).toBe('');

    const p3 = parsePhoneNumberParts('(555) 234-5678 x42');
    expect(p3.countryCode).toBe('');
    expect(p3.number).toBe('(555) 234-5678');
    expect(p3.extension).toBe('42');

    const p4 = parsePhoneNumberParts('+44 20 7946 0958 #88');
    expect(p4.countryCode).toBe('+44');
    expect(p4.number).toBe('20 7946 0958');
    expect(p4.extension).toBe('88');
  });

  it('formats full phone numbers cleanly from split fields', () => {
    expect(formatFullPhone('+1', '555-0100', '123')).toBe('+1 555-0100 ext. 123');
    expect(formatFullPhone('+91', '9876543210')).toBe('+91 9876543210');
    expect(formatFullPhone('', '555-0100', '42')).toBe('555-0100 ext. 42');
    expect(formatFullPhone('', '555-0100')).toBe('555-0100');
  });

  it('builds knowledge bundle with first name, last name, and separate phone components', () => {
    const profile = createEmptyProfile();
    profile.personal.firstName = 'Ada';
    profile.personal.lastName = 'Lovelace';
    profile.personal.phoneCountryCode = '+1';
    profile.personal.phoneNumber = '555-0100';
    profile.personal.phoneExtension = '123';

    const bundle = buildKnowledgeBundle(profile);
    const byId = new Map(bundle.items.map((i) => [i.id, i.value]));

    expect(byId.get('personal.firstName')).toBe('Ada');
    expect(byId.get('personal.lastName')).toBe('Lovelace');
    expect(byId.get('personal.fullName')).toBe('Ada Lovelace');
    expect(byId.get('personal.phoneCountryCode')).toBe('+1');
    expect(byId.get('personal.phoneNumber')).toBe('555-0100');
    expect(byId.get('personal.phoneExtension')).toBe('123');
    expect(byId.get('personal.phone')).toBe('+1 555-0100 ext. 123');
  });

  it('derives first and last name from full name if split names were not provided', () => {
    const profile = createEmptyProfile();
    profile.personal.fullName = 'Grace Brewster Murray Hopper';

    const bundle = buildKnowledgeBundle(profile);
    const byId = new Map(bundle.items.map((i) => [i.id, i.value]));

    expect(byId.get('personal.firstName')).toBe('Grace');
    expect(byId.get('personal.lastName')).toBe('Hopper');
    expect(byId.get('personal.fullName')).toBe('Grace Brewster Murray Hopper');
  });

  it('matches form field labels to corresponding alias knowledge IDs', () => {
    expect(aliasKnowledgeIds('First Name')).toContain('personal.firstName');
    expect(aliasKnowledgeIds('Given Name')).toContain('personal.firstName');
    expect(aliasKnowledgeIds('First name / Given name')).toContain('personal.firstName');
    expect(aliasKnowledgeIds('Forename')).toContain('personal.firstName');

    expect(aliasKnowledgeIds('Last Name')).toContain('personal.lastName');
    expect(aliasKnowledgeIds('Family Name')).toContain('personal.lastName');
    expect(aliasKnowledgeIds('Surname')).toContain('personal.lastName');
    expect(aliasKnowledgeIds('Last name / Family name')).toContain('personal.lastName');

    expect(aliasKnowledgeIds('Full Name')).toContain('personal.fullName');

    expect(aliasKnowledgeIds('Phone extension')).toContain('personal.phoneExtension');
    expect(aliasKnowledgeIds('Ext.')).toContain('personal.phoneExtension');

    expect(aliasKnowledgeIds('Country Code')).toContain('personal.phoneCountryCode');
    expect(aliasKnowledgeIds('Dial code')).toContain('personal.phoneCountryCode');

    expect(aliasKnowledgeIds('Phone Number')).toContain('personal.phone');
    expect(aliasKnowledgeIds('National Phone')).toContain('personal.phoneNumber');
    expect(aliasKnowledgeIds('Mobile Number')).toContain('personal.phone');
    expect(aliasKnowledgeIds('Phone')).toContain('personal.phone');
  });
});
