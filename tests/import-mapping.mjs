/**
 * Unit test for the RIDB import mapping. Runs offline against a fixture — it
 * proves the transform is correct without needing an API key or network.
 *   node tests/import-mapping.mjs
 */
const { mapFacility } = await import(new URL('../scripts/import-recreation-gov.ts', import.meta.url).href);
let pass = 0, fail = 0;
const check = (n, ok, note = '') => { ok ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, note)); };

// Shaped like a real RIDB /facilities?full=true record.
const sample = {
  FacilityID: '232447', FacilityName: 'Pine Ridge Campground',
  FacilityDescription: '<p>A wooded campground with <b>48 sites</b>.</p>',
  FacilityTypeDescr: 'Campground', FacilityLatitude: 41.8123, FacilityLongitude: -95.4477,
  FacilityPhone: '402-555-0100', FacilityDirectionsURL: 'https://example.gov/pine-ridge',
  Reservable: true,
  FACILITYADDRESS: [{ FacilityStreetAddress1: '1200 Forest Road', City: 'Blair', AddressStateCode: 'NE', PostalCode: '68008' }],
};
const m = mapFacility(sample);
check('Maps a facility to a location record', !!m);
check('Keeps the real street address', m.address_line === '1200 Forest Road' && m.city === 'Blair' && m.region === 'NE');
check('Marks federal records as verified', m.data_source === 'verified' && m.verification_status === 'verified');
check('Reservable facilities get a reservation policy', m.access_policy === 'reservation' && !!m.reservation_url);
check('Strips HTML out of descriptions', !/[<>]/.test(m.description) && m.description.includes('48 sites'));
check('Slug carries the facility id so it stays unique', m.slug.endsWith('-232447'));
check('Categorises a campground as camping', m.categories.includes('camping'));
check('Invents no safety data', !('safety_level' in m) && !('fear' in m));
check('Records provenance', m.external_source === 'ridb' && m.external_id === '232447');

check('Drops records with no coordinates', mapFacility({ ...sample, FacilityLatitude: null }) === null);
check('Drops records with no name', mapFacility({ ...sample, FacilityName: '' }) === null);
const noAddr = mapFacility({ ...sample, FACILITYADDRESS: [] });
check('No street address means approximate precision', noAddr.address_precision === 'approximate' && noAddr.address_line === null);
const trail = mapFacility({ ...sample, FacilityName: 'Cedar Bluff Trailhead', FacilityTypeDescr: 'Facility', Reservable: false });
check('Trailheads map to hiking and stay open-access', trail.categories.includes('hiking') && trail.access_policy === 'open');

console.log(`\n  ${pass} passed, ${fail} failed (facility mapping)`);
if (fail) process.exit(1);

// ---- RecAreas normalise into the same shape ---------------------------------
const { mapRecArea } = await import(new URL('../scripts/import-recreation-gov.ts', import.meta.url).href);
const area = mapRecArea({
  RecAreaID: '1105', RecAreaName: 'Cedar Wilderness Area',
  RecAreaDescription: '<p>Backcountry area with primitive sites.</p>',
  RecAreaLatitude: 44.12, RecAreaLongitude: -110.44,
  RecAreaPhone: '307-555-0144', RecAreaDirectionsURL: 'https://example.gov/cedar',
  RECAREAADDRESS: [{ City: 'Cody', AddressStateCode: 'WY' }],
  ACTIVITY: [{ ActivityName: 'HIKING' }, { ActivityName: 'CAMPING' }],
});
let p2 = 0, f2 = 0;
const c2 = (n, ok, note = '') => { ok ? (p2++, console.log('  ✅', n)) : (f2++, console.log('  ❌', n, note)); };
c2('RecArea maps into a location record', !!area);
c2('RecArea ids are namespaced so they cannot collide with facility ids', area.external_id === 'rec-1105');
c2('RIDB activity tags drive categories', area.categories.includes('hiking') && area.categories.includes('camping'));
c2('Wilderness naming adds the remote category', area.categories.includes('remote-adventures'));
c2('RecArea without a street address is marked approximate', area.address_precision === 'approximate');
c2('RecAreas are not marked reservable', area.access_policy === 'open' && area.reservation_url === null);

const biking = mapRecArea({
  RecAreaID: '7', RecAreaName: 'Ridge Loop', RecAreaLatitude: 40, RecAreaLongitude: -100,
  ACTIVITY: [{ ActivityName: 'BIKING' }], RECAREAADDRESS: [],
});
c2('Biking activity maps to the bike-trails category', biking.categories.includes('bike-trails'));

console.log(`\n  ${p2} passed, ${f2} failed (RecArea mapping)\n`);
process.exit(f2 ? 1 : 0);
