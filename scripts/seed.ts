/**
 * DEMO SEED (§52)
 *
 * IMPORTANT: every location, event and business created here is FICTIONAL and
 * flagged `is_demo = 1`. The UI renders a SAMPLE DATA chip on anything with
 * that flag. No real business is presented as verified, and no real-world
 * safety information is invented — demo records that would need verification
 * leave those fields NULL so the "Information unavailable" path is exercised.
 *
 * Coordinates are plausible points in the region so distance math is testable;
 * they are not claims about real places.
 */
import { db, run, get, all, migrate, tx, setCfg } from '../src/lib/db.ts';
import { hashPassword, AGE_ATTESTATION } from '../src/lib/auth.ts';
import { id, now, plusDays, plusHours, slugify } from '../src/lib/util.ts';
import { syncEntitlements } from '../src/services/entitlements.ts';
import { config } from '../src/config.ts';

migrate();

const RESET = process.argv.includes('--reset');
if (RESET) {
  for (const t of ['mystery_drop_reveals', 'mystery_drops', 'ai_recommendations', 'trips', 'xp_transactions',
    'user_achievements', 'badges', 'audit_logs', 'appeals', 'moderation_actions', 'moderation_cases', 'reports',
    'safety_reports', 'notifications', 'message_reactions', 'message_attachments', 'messages', 'chat_members',
    'chats', 'group_members', 'groups', 'post_likes', 'thrill_reports', 'reviews', 'media_assets', 'saved_locations',
    'attendance', 'user_blocks', 'events', 'business_profiles', 'location_categories', 'locations', 'categories',
    'payment_events', 'subscription_entitlements', 'subscriptions', 'sessions', 'profiles', 'users', 'rate_events', 'app_config']) {
    try { db.exec(`DELETE FROM ${t}`); } catch { /* table may not exist yet */ }
  }
}

const CATS: [string, string, string, string][] = [
  ['haunted-attractions', 'Haunted Attractions', '👻', 'Ticketed haunts, scream parks and walkthroughs.'],
  ['halloween-events', 'Halloween Events', '🎃', 'Seasonal festivals, trails and parties.'],
  ['paranormal', 'Paranormal', '🔦', 'Guided investigations and reportedly active sites.'],
  ['camping', 'Camping', '🏕️', 'Campgrounds, primitive sites and basecamps.'],
  ['remote-adventures', 'Remote Adventures', '🌲', 'Far from pavement, further from signal.'],
  ['night-adventures', 'Night Adventures', '🌙', 'Everything hits different after dark.'],
  ['hiking', 'Hiking', '🥾', 'Trails worth the calves.'],
  ['road-trips', 'Road Trips', '🚗', 'Routes built for a full tank and bad decisions in good company.'],
  ['horror-experiences', 'Horror Experiences', '🧟', 'Immersive, interactive, intense.'],
  ['outdoor-adventures', 'Outdoor Adventures', '🔥', 'Climbing, water, heights, adrenaline.'],
  ['bike-trails', 'Bike Trails', '🚵', 'Singletrack, rail-trails and routes worth the drive.'],
  ['cryptids', 'Cryptids & Bigfoot', '🐾', 'Places with a history of reported sightings. Reports, not proof.'],
  ['ufo-sightings', 'UFO & Sky Watching', '🛸', 'Dark-sky pullouts and sites with reported sightings.'],
  ['hidden-gems', 'Hidden Gems', '🧭', 'Weird, wonderful and under-visited.'],
  ['trending', 'Trending', '⭐', 'What the community is on right now.'],
];

const BADGES: [string, string, string, string, any][] = [
  ['first-blood', 'First Blood', '🩸', 'Filed your first Thrill Report.', { stat: 'thrill_reports', min: 1 }],
  ['night-crawler', 'Night Crawler', '🌙', 'Completed 3 night adventures.', { stat: 'night', min: 3 }],
  ['no-signal', 'No Signal', '📵', 'Completed 2 remote trips with no cell service.', { stat: 'checkins', min: 2 }],
  ['ghost-hunter', 'Ghost Hunter', '👻', 'Completed 3 haunted or paranormal experiences.', { stat: 'haunted', min: 3 }],
  ['campfire-veteran', 'Campfire Veteran', '🏕️', 'Completed 3 camping trips.', { stat: 'camping', min: 3 }],
  ['road-warrior', 'Road Warrior', '🚗', 'Completed 2 road-trip experiences.', { stat: 'road_trips', min: 2 }],
  ['fearless', 'Fearless', '💀', 'Filed 10 Thrill Reports.', { stat: 'thrill_reports', min: 10 }],
  ['pack-leader', 'Pack Leader', '🐺', 'Joined or created 3 groups.', { stat: 'groups', min: 3 }],
];

// All fictional. lat/lng are plausible regional points for distance testing.
const LOCATIONS: any[] = [
  {
    name: 'Hollow Creek Haunted Woods', tagline: 'A mile of trail. Nine acts. No safe word.',
    cats: ['haunted-attractions', 'horror-experiences', 'night-adventures'],
    description: 'A ticketed outdoor haunted trail run by a seasonal attraction operator. Groups of up to six walk a marked one-mile loop through timber with live actors and practical effects. Closed-toe shoes required; the trail is uneven and unlit between sets.',
    lore: 'The trail follows an 1880s logging road, and the attraction leans hard on a local story about a timber crew that walked out one winter and left their tools behind. County records show the camp was simply abandoned when the mill closed — no disappearance, no bodies. The operators are refreshingly upfront that the legend is marketing; the acre of genuinely unlit forest is not.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'ticketed',
    city: 'Blair', region: 'NE', lat: 41.5439, lng: -96.1253, address_precision: 'exact', address_line: '12 County Road (demo address)',
    price_text: '$28–$36', price_min_cents: 2800, website_url: 'https://example.com/hollow-creek',
    hours: { note: 'Fri–Sat 7:30pm–midnight, late Sep through early Nov (seasonal)', seasonal: 'Seasonal — September to November' },
    fear: 9.2, paranormal: 8.7, isolation: 8.4, darkness: 9.8, difficulty: 6.1,
    safety_level: 'caution',
    safety: {
      property_status: 'Private property operated as a seasonal attraction — open to ticket holders only.',
      operating_status: 'Seasonal. Check the operator before driving out.',
      reservations: 'Timed tickets recommended on weekends.',
      hazards: 'Uneven terrain, tree roots, strobe lighting, fog, loud noise.',
      terrain: 'Moderate — 1 mile of dirt trail with slopes.',
      night_access: 'Only during posted operating hours with a ticket.',
      operator: 'Sample Operator LLC (demo record)',
    },
    rating: 4.8, ratings: 212, trending: 96,
  },
  {
    name: 'Blackwater Ridge Primitive Camp', tagline: 'No hookups. No lights. No neighbours.',
    cats: ['camping', 'remote-adventures'],
    description: 'Primitive walk-in campsites managed by a county parks department. Sites are first-come, first-served with a self-pay envelope at the trailhead. Water must be packed in.',
    lore: 'Hunters have reported hearing a bell somewhere along the ridge after midnight since at least the 1950s, which local accounts tie to a school that burned in 1911. The school did exist and did burn. Nothing links it to the sound, and the most common explanation offered by people who camp here regularly is cattle.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'permit',
    city: 'Nebraska City', region: 'NE', lat: 40.6772, lng: -95.8591, address_precision: 'approximate',
    price_text: '$12/night (community-reported)', price_min_cents: 1200,
    hours: null,
    fear: 4.1, paranormal: 5.2, isolation: 9.3, darkness: 9.1, difficulty: 5.4,
    safety_level: 'elevated',
    safety: {
      permits: 'Self-issue permit required at the trailhead kiosk (community-reported).',
      cell_service: 'Community reports say none past the first ridge.',
      hazards: 'No potable water. Ticks in summer. Steep descent to the creek.',
      emergency_access: 'Nearest paved road is roughly 2 miles from the furthest sites.',
    },
    rating: 4.5, ratings: 64, trending: 71,
  },
  {
    name: 'The Drover Hotel Paranormal Investigation', tagline: 'Guided overnight. Fourth floor only.',
    cats: ['paranormal', 'horror-experiences'],
    description: 'A guided overnight investigation hosted inside a historic hotel by a licensed tour company. Participants are escorted at all times and equipment is provided. 18+ only.',
    lore: 'The fourth floor has been the subject of guest reports since the 1930s — footsteps, doors, a woman in the corridor. The hotel has never claimed these are supernatural and keeps a logbook of every report, including the ones later explained by plumbing. Reading that log is genuinely the best part of the tour.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'guided',
    city: 'Council Bluffs', region: 'IA', lat: 41.2619, lng: -95.8608, address_precision: 'exact', address_line: '400 Sample Street (demo address)',
    price_text: '$85 per person', price_min_cents: 8500, reservation_url: 'https://example.com/drover-booking',
    hours: { note: 'Investigations run 10pm–3am, select Saturdays' },
    fear: 7.4, paranormal: 9.6, isolation: 3.2, darkness: 8.8, difficulty: 2.1,
    safety_level: 'low',
    safety: {
      property_status: 'Private property. Access only on a booked, guided investigation.',
      operating_status: 'Operating — select dates.',
      reservations: 'Required. Sells out weeks ahead.',
      operator: 'Sample Paranormal Tours (demo record)',
      emergency_access: 'Staffed building, street access.',
      night_access: 'Only with the guide. Do not enter outside booked hours.',
    },
    rating: 4.9, ratings: 143, trending: 88,
  },
  {
    name: 'Sandhills Dark Sky Overlook', tagline: 'The Milky Way, unreasonably loud.',
    cats: ['night-adventures', 'hiking', 'hidden-gems'],
    description: 'A public overlook with minimal light pollution, popular with astrophotographers. Gravel lot, short walk to the rim, no facilities.',
    lore: 'A 1972 sighting here made regional papers and still circulates in UFO forums. The Air Force attributed it to a refuelling exercise out of a nearby base, and the timing matches. What remains true regardless is the sky: this is one of the darkest accessible spots in the state.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Broken Bow', region: 'NE', lat: 41.4014, lng: -99.6387, address_precision: 'approximate',
    price_text: 'Free', price_min_cents: 0, hours: { note: 'Open 24h (community-reported)' },
    fear: 2.8, paranormal: 3.9, isolation: 8.9, darkness: 9.9, difficulty: 3.2,
    safety_level: 'caution',
    safety: {
      hazards: 'Unfenced drop at the rim. Bring headlamps and park fully off the roadway.',
      cell_service: 'Spotty — community-reported.',
      weather: 'Wind exposure; conditions change fast after dark.',
    },
    rating: 4.7, ratings: 88, trending: 64,
  },
  {
    name: 'Ironwood Scream Park', tagline: 'Four attractions. One wristband. Zero dignity.',
    cats: ['haunted-attractions', 'halloween-events'],
    description: 'A multi-attraction seasonal scream park with indoor haunted houses, a midway and food vendors. Family-friendly early hours, 18+ intense hours after 10pm.',
    lore: 'Built on a former drive-in cinema lot, which the park works into its own mythology with a fictional projectionist. Entirely invented, and the park says so on its own website — a rare and welcome thing in this industry.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'ticketed',
    city: 'Omaha', region: 'NE', lat: 41.2565, lng: -95.9345, address_precision: 'exact', address_line: '900 Sample Boulevard (demo address)',
    price_text: '$39 all-access', price_min_cents: 3900, website_url: 'https://example.com/ironwood',
    hours: { note: 'Thu–Sun 7pm–1am during the season' },
    fear: 8.1, paranormal: 4.4, isolation: 2.2, darkness: 8.6, difficulty: 3.0,
    safety_level: 'low',
    safety: {
      property_status: 'Private venue, open to ticket holders.',
      operating_status: 'Seasonal.',
      reservations: 'Walk-ups accepted; weekends sell out.',
      hazards: 'Strobe lighting, fog, loud audio, actors in close proximity.',
      emergency_access: 'On-site staff and first aid.',
      operator: 'Sample Attractions Co. (demo record)',
    },
    rating: 4.6, ratings: 431, trending: 92,
  },
  {
    name: 'Loess Bluff Night Trail', tagline: '6.2 miles. Headlamps mandatory. Ridgeline the whole way.',
    cats: ['hiking', 'night-adventures', 'outdoor-adventures'],
    description: 'A public trail system that permits after-dark use on marked routes. The ridge section is exposed with steep drop-offs on the east side.',
    lore: 'The bluffs are genuine loess deposits, wind-laid over thousands of years, and locally famous for the way sound carries strangely along them. That acoustic quirk is real and measurable. The ghost stories attached to it are not, though the trail after dark makes them easy to believe.',
    data_source: 'community', verification_status: 'pending', access_policy: 'open',
    city: 'Missouri Valley', region: 'IA', lat: 41.5572, lng: -95.8853, address_precision: 'approximate',
    price_text: 'Free', price_min_cents: 0, hours: null,
    fear: 5.2, paranormal: 4.0, isolation: 7.1, darkness: 9.2, difficulty: 7.6,
    safety_level: 'elevated',
    safety: {
      hazards: 'Steep unguarded drop-offs, loose loess soil after rain.',
      terrain: 'Strenuous — 1,100 ft cumulative gain.',
      night_access: 'Community-reported as permitted on marked trails; verify current park rules.',
    },
    rating: 4.4, ratings: 57, trending: 58,
  },
  {
    name: 'The Larkin Sanatorium (CLOSED — DO NOT ENTER)', tagline: 'Listed for awareness. Entry is not permitted.',
    cats: ['hidden-gems'],
    description: 'A decommissioned private facility that appears frequently in local folklore. The property is fenced, monitored and strictly closed to the public. This listing exists so people stop asking how to get in: you cannot, legally, and THRILLHUNT will not help you try. There are guided, legal alternatives in the Paranormal category.',
    lore: 'A tuberculosis sanatorium that operated until the 1950s. Its reputation online rests on a widely-shared body count that does not match county health records — the real figure is far lower, and the deaths were from tuberculosis, in a hospital, which is what hospitals in that era were for. The building is now structurally unsound and actively patrolled. People have been seriously hurt inside it.',
    data_source: 'restricted', verification_status: 'verified', access_policy: 'private_closed',
    city: 'Fremont', region: 'NE', lat: 41.4333, lng: -96.4981, address_precision: 'approximate',
    price_text: null, price_min_cents: null, hours: null,
    fear: null, paranormal: null, isolation: null, darkness: null, difficulty: null,
    safety_level: 'high',
    safety: {
      property_status: 'PRIVATE PROPERTY — CLOSED. Entry is trespassing and is actively enforced.',
      operating_status: 'Permanently closed to visitors.',
      hazards: 'Structurally unsound. Asbestos. No emergency access.',
      emergency_access: 'None.',
    },
    rating: 0, ratings: 0, trending: 12,
  },
  {
    name: 'Steel Rail Trail — Loess Bluff Segment', tagline: '14 miles of crushed limestone through the bluffs.',
    cats: ['bike-trails', 'hiking', 'outdoor-adventures'],
    description: 'A converted rail corridor with a crushed-limestone surface, gentle grade and three trestle crossings. Popular for gravel bikes and hybrids; a road bike will hate it.',
    lore: 'The corridor carried freight until the 1970s and the trestles are original ironwork. Riders trade a story about a signalman still walking the line at dusk; the trail district notes the trestles make noise as they cool, which is when people tend to hear him.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'open',
    city: 'Plattsmouth', region: 'NE', lat: 40.9721, lng: -95.8899, address_precision: 'exact', address_line: 'Sample Depot Trailhead, 1 Rail Street (demo address)',
    price_text: 'Free — state trail pass required for riders 16+', website_url: 'https://example.com/steel-rail-trail',
    hours: { note: 'Open dawn to dusk year round; unlit after sunset' },
    fear: 1.2, paranormal: 1.0, isolation: 4.1, darkness: 6.2, difficulty: 3.4,
    safety_level: 'low',
    safety: {
      surface: 'Crushed limestone. Gravel or hybrid tyres recommended; not suitable for narrow road tyres.',
      trail_status: 'Open. Trestle 2 closes after heavy rain — check the trail district before driving out.',
      cell_service: 'Good at both trailheads, patchy in the cut between miles 6 and 9.',
      water: 'Potable water at the depot trailhead only.',
      night_access: 'Trail is unlit and closes at dusk.',
      emergency_access: 'Numbered mile markers; county road crossings roughly every 3 miles.',
      operator: 'Sample Trail District (demo record)',
    },
    rating: 4.7, ratings: 289, trending: 63,
  },
  {
    name: 'Elkhorn Ridge Singletrack Loop', tagline: 'Eight miles of rooty, rowdy, self-inflicted suffering.',
    cats: ['bike-trails', 'outdoor-adventures', 'night-adventures'],
    description: 'Volunteer-built singletrack on a wooded ridge. Two stacked loops with a black-diagnosed descent locals call the Washboard. Night riding is permitted with lights.',
    lore: 'Built by volunteers over roughly a decade. The descent locals call the Washboard is named for the rhythm of exposed roots, not for anything stranger — though the trail association keeps a tally of riders who swear the woods go abruptly silent at the bottom of it.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Elkhorn', region: 'NE', lat: 41.2870, lng: -96.2350, address_precision: 'approximate',
    price_text: 'Free — donations fund trail maintenance',
    fear: 2.4, paranormal: 1.3, isolation: 5.0, darkness: 7.8, difficulty: 7.6,
    safety_level: 'caution',
    safety: {
      difficulty_note: 'Community-rated intermediate to advanced. The lower descent has exposed roots and a drop most riders walk.',
      trail_status: 'Community reports say the loop closes when wet — riding it muddy destroys the surface.',
      night_access: 'Community reports say night riding is allowed. Confirm with the trail association before riding after dark.',
      gear: 'Helmet essential. Riders report carrying a tube, a pump and lights year round.',
    },
    rating: 4.4, ratings: 97, trending: 78,
  },
  {
    name: 'Cutler Bend Cryptid Corridor', tagline: 'Decades of reported sightings. Zero evidence. Great walk.',
    cats: ['cryptids', 'hiking', 'remote-adventures', 'hidden-gems'],
    description: 'A stretch of public forest road along a river bend that has collected reported Bigfoot and large-animal sightings since the 1970s. THRILLHUNT lists it because people search for it, not because any sighting has been substantiated. The walking is genuinely good and the bottomland is dense enough that misidentification is easy after dark.',
    lore: 'Reports began in 1971 with a hunter\'s account that ran in a regional paper, and the location has drawn sightings ever since. No physical evidence has ever been produced here. Wildlife officers point to black bear outside their usual range, loose cattle and the bottomland\'s genuinely disorienting acoustics. The reports are real; what they describe remains unestablished.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Decatur', region: 'NE', lat: 41.9930, lng: -96.2470, address_precision: 'approximate',
    price_text: 'Free — public forest road',
    fear: 5.8, paranormal: 6.9, isolation: 8.4, darkness: 9.1, difficulty: 4.2,
    safety_level: 'caution',
    safety: {
      evidence_status: 'No sighting associated with this location has ever been verified. Treat every report, including the ones in our chat, as an unverified claim.',
      property_status: 'Public forest road. Private land begins at the fence line on the east side — do not cross it.',
      wildlife: 'Black bear are not present here; the large animals people do encounter are deer, coyote and loose cattle.',
      cell_service: 'Community reports say service drops about a mile in.',
      night_access: 'Road is open at night. It is unlit, unpatrolled and easy to get turned around on.',
      hunting: 'Community reports say this is an active hunting area in autumn — wear blaze orange.',
    },
    rating: 4.1, ratings: 58, trending: 88,
  },
  {
    name: 'Route 12 Sky Watch Pullout', tagline: 'Bring a chair, a thermos and low expectations.',
    cats: ['ufo-sightings', 'night-adventures', 'road-trips', 'hidden-gems'],
    description: 'A gravel pullout on a ridge with an unobstructed northern horizon and very little ground light. It has a long history of reported UFO sightings; it is also directly under a regional air corridor, which accounts for a great deal of what people see. Either way it is one of the darkest easily-reachable skies in the area.',
    lore: 'This stretch of highway has collected sighting reports since the late 1960s, with a documented cluster in 1978 that drew state police attention. The pullout also sits directly beneath a regional air corridor, and the 1978 cluster coincides with a scheduled military exercise. Both facts are on the record.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Niobrara', region: 'NE', lat: 42.7480, lng: -98.0320, address_precision: 'approximate',
    price_text: 'Free — roadside pullout',
    fear: 2.1, paranormal: 7.2, isolation: 8.8, darkness: 9.6, difficulty: 1.5,
    safety_level: 'caution',
    safety: {
      evidence_status: 'No reported sighting here has been verified. Aircraft, satellites and Starlink trains account for most reports.',
      parking: 'Gravel pullout with room for roughly six vehicles. Do not block the approach.',
      road_safety: 'This is an active highway shoulder. Park fully off the pavement and keep headlamps off the road.',
      cell_service: 'Community reports say one bar, intermittent.',
      weather: 'Exposed ridge. Wind chill is the real hazard on a clear winter night.',
      emergency_access: 'Highway access, but the nearest town is roughly 20 minutes away.',
    },
    rating: 4.5, ratings: 73, trending: 81,
  },
  {
    name: 'Cape Hollow Lighthouse Night Tour', tagline: 'Guided climb after dark. 214 steps, one story per landing.',
    cats: ['paranormal', 'haunted-attractions', 'night-adventures'],
    description: 'A guided after-hours climb of a working lighthouse, run by the preservation society that maintains it. Groups are escorted and the lamp room is off limits.',
    lore: 'The light has operated since 1872 and the preservation society\'s archive includes keepers\' logs describing sounds on the stairs during storms. The society\'s own position is that a 214-step iron spiral in high wind makes noise. They tell the stories anyway, and they tell you that part too.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'guided',
    city: 'Outer Banks', region: 'NC', lat: 35.2510, lng: -75.5290, address_precision: 'exact', address_line: '1 Sample Point Road (demo address)',
    price_text: '$28 per person', hours: { note: 'Thursday to Sunday, tours at 8pm and 9:30pm' },
    fear: 4.6, paranormal: 7.1, isolation: 3.4, darkness: 7.9, difficulty: 4.8,
    safety_level: 'caution',
    safety: { terrain: 'Spiral iron staircase, 214 steps, no lift. Not suitable for anyone who should avoid sustained stair climbing.',
              hazards: 'Low headroom at two landings. Handrail on one side only.',
              cell_service: 'Good throughout.', emergency_access: 'Staffed site, road access to the base.' },
    rating: 4.8, ratings: 412, trending: 71,
  },
  {
    name: 'Mojave Ghost Town Overnight', tagline: 'A bought-and-restored mining town you can legally sleep in.',
    cats: ['remote-adventures', 'paranormal', 'camping', 'road-trips'],
    description: 'Privately owned former mining settlement, restored and open to booked overnight guests. Self-catered cabins, no services after dark.',
    lore: 'A copper settlement that emptied within two years when the seam ran out in 1907. The current owners restored it from ruins and are careful to separate documented history — census records, company ledgers — from the stories visitors bring back. They keep a guest book of both.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'reservation',
    city: 'Barstow', region: 'CA', lat: 35.0180, lng: -116.7690, address_precision: 'exact', address_line: '2200 Sample Mine Road (demo address)',
    price_text: '$140 per cabin per night',
    fear: 6.2, paranormal: 8.0, isolation: 9.1, darkness: 9.4, difficulty: 3.9,
    safety_level: 'elevated',
    safety: { hazards: 'Open mine shafts are fenced but present. Do not cross fencing under any circumstances.',
              cell_service: 'No service. Satellite phone at the caretaker cabin.',
              water: 'Bring all drinking water — none available on site.',
              emergency_access: 'Graded dirt road, 40 minutes to the nearest paved highway.',
              weather: 'Summer daytime heat regularly exceeds 105°F. Winter nights drop below freezing.' },
    rating: 4.6, ratings: 168, trending: 84,
  },
  {
    name: 'Skyline Gorge Via Ferrata', tagline: 'Cabled climbing route across an exposed limestone gorge.',
    cats: ['outdoor-adventures', 'hiking', 'remote-adventures'],
    description: 'A guided via ferrata: fixed cables and iron rungs across a gorge wall. All technical gear provided; no prior climbing experience required, but a head for heights is non-negotiable.',
    lore: 'The cable route follows a miners\' path cut into the gorge wall in the 1890s, and some of the original iron anchors are still visible beside the modern hardware. The guides\' history is documented and the ghost stories are, by their own cheerful admission, entirely for the drive home.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'guided',
    city: 'Ouray', region: 'CO', lat: 38.0230, lng: -107.6720, address_precision: 'exact', address_line: '7 Sample Canyon Road (demo address)',
    price_text: '$155 guided, gear included', hours: { note: 'May to October, weather permitting' },
    fear: 7.8, paranormal: 1.0, isolation: 6.2, darkness: 2.1, difficulty: 8.6,
    safety_level: 'elevated',
    safety: { terrain: 'Sustained exposure with a 300ft drop. You are clipped to a cable the whole way.',
              hazards: 'Rockfall risk after rain. Route closes in electrical storms.',
              permits: 'Guided access only — the route cannot be climbed independently.',
              cell_service: 'Patchy in the gorge.', emergency_access: 'Guides carry radios; helicopter evacuation is the realistic option from mid-route.' },
    rating: 4.9, ratings: 233, trending: 76,
  },
  {
    name: 'Bayou Cemetery Lantern Walk', tagline: 'Above-ground tombs, a licensed guide, and no flash photography.',
    cats: ['paranormal', 'haunted-attractions', 'night-adventures', 'hidden-gems'],
    description: 'Licensed evening walking tour of a historic above-ground cemetery. The site is active and family-owned; the tour operates under a permit and stays on marked paths.',
    lore: 'Above-ground burial here is a response to the water table, not superstition — a practical detail that gets mythologised constantly. The tour spends as much time correcting popular ghost-tour inventions about the families buried here as it does telling stories, at the families\' explicit request.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'ticketed',
    city: 'New Orleans', region: 'LA', lat: 29.9590, lng: -90.0860, address_precision: 'exact', address_line: '415 Sample Avenue (demo address)',
    price_text: '$32 per person', hours: { note: 'Nightly, 7pm and 8:45pm' },
    fear: 5.1, paranormal: 7.8, isolation: 2.2, darkness: 7.2, difficulty: 1.8,
    safety_level: 'low',
    safety: { property_status: 'Active cemetery. Entry outside tour hours is prohibited and enforced.',
              hazards: 'Uneven brick paths and low kerbs. Sensible shoes.',
              cell_service: 'Good.', emergency_access: 'Street access on all four sides.' },
    rating: 4.7, ratings: 587, trending: 88,
  },
  {
    name: 'Adirondack Fire Tower Dark Sky Hike', tagline: 'A three-mile climb to a restored tower and a very large sky.',
    cats: ['hiking', 'night-adventures', 'ufo-sightings', 'camping'],
    description: 'Public trail to a restored fire tower on a summit with minimal light pollution. Popular for meteor showers; the tower cab itself is locked after dusk.',
    lore: 'The tower was staffed for fire spotting until 1988, and the summit register goes back decades. Sighting reports here spiked sharply after 2019, which coincides exactly with the first Starlink launches — the satellite trains are visible from the summit on most clear nights.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Lake Placid', region: 'NY', lat: 44.2795, lng: -73.9799, address_precision: 'approximate',
    price_text: 'Free — state land',
    fear: 3.2, paranormal: 5.4, isolation: 7.6, darkness: 9.3, difficulty: 6.4,
    safety_level: 'caution',
    safety: { evidence_status: 'Reported sightings here are almost certainly satellites and aircraft on the Montreal approach. The dark sky is real; the rest is unverified.',
              terrain: 'Three miles each way, roughly 1,800ft of gain. Rocky and root-bound near the top.',
              night_access: 'Trail is open at night and unlit. Community reports say the descent is where people get hurt.',
              cell_service: 'Community reports say no service above the second lean-to.',
              wildlife: 'Black bear are present. Store food properly.' },
    rating: 4.5, ratings: 149, trending: 69,
  },
  {
    name: 'Cascade Cryptid Ridge', tagline: 'Old-growth forest with a long Sasquatch reporting history.',
    cats: ['cryptids', 'hiking', 'remote-adventures', 'camping'],
    description: 'A stretch of forest road and trail in old-growth timber with reported Sasquatch sightings dating to the 1960s. Listed because people search for it. The forest is genuinely spectacular and genuinely easy to get lost in.',
    lore: 'One of the most-reported areas in the Pacific Northwest, with accounts dating to logging crews in the 1960s. No verified evidence has come from here in sixty years of looking. The old-growth stand is, separately and genuinely, one of the most impressive pieces of forest you can walk into from a road.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Mount Baker', region: 'WA', lat: 48.7770, lng: -121.8130, address_precision: 'approximate',
    price_text: 'Free — national forest, parking pass required',
    fear: 5.4, paranormal: 6.8, isolation: 8.9, darkness: 9.0, difficulty: 6.1,
    safety_level: 'caution',
    safety: { evidence_status: 'No sighting associated with this area has ever been substantiated. Bear, elk and logging equipment account for the overwhelming majority of reports.',
              cell_service: 'Community reports say service ends at the forest boundary.',
              weather: 'Rain and low cloud year round. Hypothermia is the actual risk here, not folklore.',
              wildlife: 'Black bear and cougar are both present.',
              night_access: 'Forest roads are unlit, unpaved and unpatrolled after dark.' },
    rating: 4.3, ratings: 91, trending: 79,
  },
  {
    name: 'Great Lakes Shipwreck Night Paddle', tagline: 'Clear-bottom kayaks over a wreck in twelve feet of water.',
    cats: ['outdoor-adventures', 'night-adventures', 'hidden-gems'],
    description: 'Guided evening paddle over a nineteenth-century schooner wreck visible through clear water. Lit kayaks, guide-led, weather dependent.',
    lore: 'The schooner went down in an 1879 gale with all hands recovered alive — a rescue story rather than a tragedy, which is not how it usually gets retold. The wreck sits in twelve feet of water and the guides carry the original newspaper account.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'reservation',
    city: 'Munising', region: 'MI', lat: 46.4110, lng: -86.6490, address_precision: 'exact', address_line: '18 Sample Harbor Drive (demo address)',
    price_text: '$89 per paddler', hours: { note: 'June to September, departures at dusk' },
    fear: 3.4, paranormal: 4.2, isolation: 5.1, darkness: 7.4, difficulty: 5.2,
    safety_level: 'caution',
    safety: { hazards: 'Cold water year round — immersion is a genuine hypothermia risk.',
              terrain: 'Open water. Trips cancel on short notice when wind picks up.',
              permits: 'Guide-led only. Life jackets mandatory and provided.',
              cell_service: 'Good at the harbor, none on the water.',
              emergency_access: 'Guides carry marine radio; Coast Guard station is 20 minutes out.' },
    rating: 4.8, ratings: 276, trending: 73,
  },
  {
    name: 'Sonoran Desert Ghost Mine Trail', tagline: 'Twelve miles of desert singletrack past a sealed mine.',
    cats: ['bike-trails', 'outdoor-adventures', 'hidden-gems'],
    description: 'Desert singletrack loop through saguaro country, passing the sealed entrance of a former copper mine. Fast, rocky, and completely exposed.',
    lore: 'The mine worked copper from 1890 until a 1931 collapse, after which it was sealed. Riders trade stories about sounds from the shaft; the county notes that sealed mines breathe audibly as air pressure changes through the day. Both things are true at once.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Tucson', region: 'AZ', lat: 32.2530, lng: -110.9110, address_precision: 'approximate',
    price_text: 'Free — county park',
    fear: 2.2, paranormal: 3.1, isolation: 6.4, darkness: 8.1, difficulty: 7.2,
    safety_level: 'elevated',
    safety: { surface: 'Decomposed granite and embedded rock. Tubeless tyres strongly recommended — community reports say punctures are constant otherwise.',
              hazards: 'The mine entrance is sealed and must stay that way. Cholla spines are the other reliable hazard.',
              weather: 'Summer riding is dangerous after 9am. Heat illness, not terrain, is what puts people in hospital here.',
              water: 'No water on the loop. Community reports say three litres minimum in warm months.',
              wildlife: 'Rattlesnakes are active at dawn and dusk.' },
    rating: 4.4, ratings: 203, trending: 66,
  },
  {
    name: 'Everglades Backcountry Chickee Camp', tagline: 'A raised platform, an hour by paddle, and no dry land.',
    cats: ['camping', 'remote-adventures', 'night-adventures'],
    description: 'Permitted backcountry camping on a raised wooden platform in open water, reachable only by kayak or canoe. No facilities beyond the platform itself.',
    lore: 'Chickee platforms follow a Seminole building form adapted for open water, and the Park Service is explicit that the design is borrowed, not invented. Paddlers report lights over the water at night, most of which are other paddlers.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'permit',
    city: 'Everglades City', region: 'FL', lat: 25.8580, lng: -81.3870, address_precision: 'approximate',
    price_text: 'Backcountry permit required, $15 plus per-person fee',
    fear: 5.8, paranormal: 3.2, isolation: 9.4, darkness: 9.2, difficulty: 7.8,
    safety_level: 'elevated',
    safety: { permits: 'Backcountry permit mandatory, issued in person at the visitor centre within 24 hours of departure.',
              hazards: 'American alligators and American crocodiles are both present. There is no dry land at the site.',
              cell_service: 'No service. Carry a satellite messenger.',
              water: 'Carry all fresh water for the whole trip.',
              emergency_access: 'Boat access only. Assume several hours to any assistance.',
              weather: 'Afternoon storms are routine in summer; the platform is fully exposed.' },
    rating: 4.7, ratings: 134, trending: 81,
  },
  {
    name: 'Texas Hill Country Star Party Field', tagline: 'A dark-sky field where the telescopes outnumber the people.',
    cats: ['ufo-sightings', 'camping', 'night-adventures', 'road-trips'],
    description: 'A privately run dark-sky field that opens to the public on new-moon weekends for astronomy. White light is not permitted after dusk — red torches only.',
    lore: 'The field sits near one of the oldest observatories in the region, and the surrounding ranges have a long history of unexplained-light reports — including the famous ones a few counties south, which have been studied repeatedly and most convincingly attributed to distant headlights and atmospheric refraction. The dark sky here is genuinely world-class.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'reservation',
    city: 'Fort Davis', region: 'TX', lat: 30.5980, lng: -103.8940, address_precision: 'exact', address_line: '3400 Sample Observatory Road (demo address)',
    price_text: '$20 per vehicle, new-moon weekends', hours: { note: 'Gates open 6pm, close at dawn, new-moon weekends only' },
    fear: 1.8, paranormal: 6.4, isolation: 8.2, darkness: 9.8, difficulty: 1.4,
    safety_level: 'low',
    safety: { evidence_status: 'One of the darkest skies in the lower 48. Reported sightings here are overwhelmingly satellites, meteors and the occasional military aircraft out of the nearby ranges.',
              night_access: 'White light is prohibited after dusk, including phone screens. Bring a red torch.',
              cell_service: 'One bar, intermittent.',
              weather: 'Elevation is 5,000ft — nights are cold even in summer.',
              emergency_access: 'Staffed gate, paved road to the highway.' },
    rating: 4.9, ratings: 318, trending: 90,
  },
  {
    name: 'Cottonwood Hollow Campground', tagline: 'Firewood, river access, and a very loud owl.',
    cats: ['camping', 'road-trips'],
    description: 'A managed campground with reservable sites, potable water and vault toilets. Popular staging point for river paddling.',
    lore: 'An unremarkable and well-run river campground with no legend attached to it whatsoever, which is why regulars recommend it as a basecamp for everywhere else on this list.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'reservation',
    city: 'Plattsmouth', region: 'NE', lat: 41.0111, lng: -95.8822, address_precision: 'exact', address_line: '55 Sample River Road (demo address)',
    price_text: '$22–$30/night', price_min_cents: 2200, reservation_url: 'https://example.com/cottonwood-reserve',
    hours: { note: 'Check-in 2pm, quiet hours 10pm–7am' },
    fear: 1.9, paranormal: 3.1, isolation: 5.5, darkness: 7.4, difficulty: 2.0,
    safety_level: 'low',
    safety: {
      reservations: 'Required in peak season.',
      cell_service: 'Reliable at the office, patchy at riverside sites.',
      weather: 'River sites flood — check the forecast.',
      operator: 'Sample Parks District (demo record)',
      emergency_access: 'Paved access road, camp host on site.',
    },
    rating: 4.3, ratings: 176, trending: 44,
  },
];

const USERS = [
  { username: 'JAKETHEEXPLORER', email: 'jake@demo.thrillhunt.test', emoji: '🧭', bio: 'If it is dark, muddy, or allegedly haunted, I am already in the car.', city: 'Omaha, NE', lat: 41.2565, lng: -95.9345, xp: 7450, pro: true },
  { username: 'sarah_nocturne', email: 'sarah@demo.thrillhunt.test', emoji: '🌙', bio: 'Night hikes and bad ideas. Will drive 3 hours for a good trail.', city: 'Lincoln, NE', lat: 40.8136, lng: -96.7026, xp: 3120, pro: false },
  { username: 'mikeonthemap', email: 'mike@demo.thrillhunt.test', emoji: '🔦', bio: 'Paranormal investigation hobbyist. Skeptic with a full kit.', city: 'Council Bluffs, IA', lat: 41.2619, lng: -95.8608, xp: 1890, pro: false },
  { username: 'campfire_kate', email: 'kate@demo.thrillhunt.test', emoji: '🏕️', bio: 'Primitive sites only. Bring coffee.', city: 'Blair, NE', lat: 41.5439, lng: -96.1253, xp: 5010, pro: true },
];

tx(() => {
  // categories
  CATS.forEach(([slug, name, icon, blurb], i) =>
    run(`INSERT INTO categories (id, slug, name, icon, blurb, sort_order, active) VALUES (?,?,?,?,?,?,1)
         ON CONFLICT(slug) DO UPDATE SET name=excluded.name, icon=excluded.icon`, [id('cat'), slug, name, icon, blurb, i]));

  BADGES.forEach(([slug, name, icon, desc, rule]) =>
    run(`INSERT INTO badges (id, slug, name, icon, description, rule_json, pro_only) VALUES (?,?,?,?,?,?,0)
         ON CONFLICT(slug) DO NOTHING`, [id('bdg'), slug, name, icon, desc, JSON.stringify(rule)]));

  // locations
  for (const L of LOCATIONS) {
    const lid = id('loc');
    const slug = slugify(L.name);
    run(`INSERT INTO locations (id, slug, name, tagline, description, lore, data_source, verification_status, verified_at, is_demo,
          access_policy, address_line, city, region, country, lat, lng, address_precision, website_url, hours_json, price_text,
          price_min_cents, reservation_url, fear, paranormal, isolation, darkness, difficulty, rating_avg, rating_count,
          interested_count, trending_score, safety_level, safety_json, moderation_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?, 'US', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved', ?,?)
         ON CONFLICT(slug) DO NOTHING`,
      [lid, slug, L.name, L.tagline, L.description, L.lore ?? null, L.data_source, L.verification_status,
       L.verification_status === 'verified' ? now() : null, L.access_policy, L.address_line ?? null, L.city, L.region,
       L.lat, L.lng, L.address_precision, L.website_url ?? null, L.hours ? JSON.stringify(L.hours) : null,
       L.price_text ?? null, L.price_min_cents ?? null, L.reservation_url ?? null,
       L.fear, L.paranormal, L.isolation, L.darkness, L.difficulty, L.rating, L.ratings,
       Math.floor(L.ratings / 6), L.trending, L.safety_level, JSON.stringify(L.safety ?? {}), now(), now()]);

    const loc = get<any>('SELECT id FROM locations WHERE slug = ?', [slug])!;
    for (const c of L.cats) {
      const cat = get<any>('SELECT id FROM categories WHERE slug = ?', [c]);
      if (cat) run('INSERT OR IGNORE INTO location_categories (location_id, category_id) VALUES (?,?)', [loc.id, cat.id]);
    }
    // Location chat exists for every visitable location.
    if (L.access_policy !== 'private_closed' && !get('SELECT id FROM chats WHERE location_id = ?', [loc.id])) {
      run('INSERT INTO chats (id, kind, location_id, title, created_at) VALUES (?,?,?,?,?)', [id('cht'), 'location', loc.id, L.name, now()]);
    }
    if (L.data_source === 'verified') {
      run(`INSERT INTO business_profiles (id, location_id, legal_name, contact_email, claim_status, verified_at, created_at, updated_at)
           VALUES (?,?,?,?, 'verified', ?,?,?)`,
        [id('biz'), loc.id, `${L.name} (sample business record)`, 'ops@example.com', now(), now(), now()]);
    }
  }

  // events
  const evLoc = (slug: string) => get<any>('SELECT id FROM locations WHERE slug = ?', [slug])?.id;
  const evs: [string, string, string, number, string][] = [
    ['hollow-creek-haunted-woods', 'Blackout Night — no glow sticks', 'Lights-down run of the full trail. 18+ only.', 3, '$36'],
    ['ironwood-scream-park', 'Opening Weekend', 'All four attractions open, midway food vendors on site.', 6, '$39'],
    ['the-drover-hotel-paranormal-investigation', 'Fourth Floor Overnight', 'Guided 10pm–3am investigation, equipment provided.', 9, '$85'],
    ['cottonwood-hollow-campground', 'Group Campout — river sites', 'Community campout, reservable group loop.', 14, '$25'],
  ];
  for (const [slug, title, desc, days, price] of evs) {
    const lid = evLoc(slug);
    if (lid) run(`INSERT INTO events (id, location_id, title, description, starts_at, price_text, data_source, is_demo, created_at)
                  VALUES (?,?,?,?,?,?, 'verified', 1, ?)`, [id('evt'), lid, title, desc, plusDays(days), price, now()]);
  }

  // users
  for (const U of USERS) {
    if (get('SELECT id FROM users WHERE email = ?', [U.email])) continue;
    const uid = id('usr');
    run(`INSERT INTO users (id, email, password_hash, role, status, age_confirmed_at, age_attestation, tos_version, created_at, updated_at)
         VALUES (?,?,?, 'user', 'active', ?,?,?,?,?)`,
      [uid, U.email, hashPassword('DemoPass!2026'), now(), AGE_ATTESTATION, config.tosVersion, now(), now()]);
    run(`INSERT INTO profiles (user_id, username, display_name, avatar_emoji, bio, home_city, home_lat, home_lng, xp, level, favorite_categories, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, U.username, U.username, U.emoji, U.bio, U.city, U.lat, U.lng, U.xp,
       Math.max(1, Math.floor(Math.sqrt(U.xp / 20)) + 1), JSON.stringify(['haunted-attractions', 'camping', 'night-adventures']), now(), now()]);
    if (U.pro) {
      run(`INSERT INTO subscriptions (id, user_id, provider, provider_customer_id, provider_subscription_id, plan_id, status,
            cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at)
           VALUES (?,?, 'mock', ?,?, 'pro_monthly', 'active', 0, ?,?,?,?)`,
        [id('sub'), uid, `mockcus_${uid}`, `mock_${uid}`, now(), plusDays(30), now(), now()]);
    }
    syncEntitlements(uid);
  }

  // admin + moderator
  for (const [email, username, role] of [['admin@thrillhunt.test', 'TH_ADMIN', 'admin'], ['mod@thrillhunt.test', 'TH_MOD', 'moderator']]) {
    if (get('SELECT id FROM users WHERE email = ?', [email])) continue;
    const uid = id('usr');
    run(`INSERT INTO users (id, email, password_hash, role, status, age_confirmed_at, age_attestation, tos_version, created_at, updated_at)
         VALUES (?,?,?,?, 'active', ?,?,?,?,?)`,
      [uid, email, hashPassword('AdminPass!2026'), role, now(), AGE_ATTESTATION, config.tosVersion, now(), now()]);
    run(`INSERT INTO profiles (user_id, username, display_name, avatar_emoji, bio, created_at, updated_at)
         VALUES (?,?,?, '🛡️', 'THRILLHUNT staff account.', ?,?)`, [uid, username, username, now(), now()]);
    syncEntitlements(uid);
  }

  // social activity
  const jake = get<any>(`SELECT user_id FROM profiles WHERE username = 'JAKETHEEXPLORER'`)!.user_id;
  const sarah = get<any>(`SELECT user_id FROM profiles WHERE username = 'sarah_nocturne'`)!.user_id;
  const mike = get<any>(`SELECT user_id FROM profiles WHERE username = 'mikeonthemap'`)!.user_id;
  const kate = get<any>(`SELECT user_id FROM profiles WHERE username = 'campfire_kate'`)!.user_id;
  const hollow = get<any>(`SELECT id FROM locations WHERE slug = 'hollow-creek-haunted-woods'`)!.id;
  const hollowChat = get<any>('SELECT id FROM chats WHERE location_id = ?', [hollow])!.id;

  const msgs: [string, string][] = [
    [mike, 'Anyone going Saturday? I have room for 3 coming from Council Bluffs.'],
    [sarah, 'Thinking about it. Is the back half of the trail as muddy as people say?'],
    [jake, "I'm coming from Omaha. Boots, not sneakers — learned that the hard way last year."],
    [sarah, 'Want to make a group? Easier than coordinating in here.'],
    [kate, "In. I'll camp at Cottonwood after so I'm not driving back at 2am."],
  ];
  let t = Date.now() - 36e5;
  for (const [uid, body] of msgs) {
    run('INSERT OR IGNORE INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [hollowChat, uid, 'active', now()]);
    run('INSERT INTO messages (id, chat_id, user_id, body, moderation_status, created_at) VALUES (?,?,?,?, \'approved\', ?)',
        [id('msg'), hollowChat, uid, body, new Date(t += 6e5).toISOString()]);
  }

  // attendance
  const sat = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const sun = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  for (const [uid, date] of [[jake, sat], [sarah, sat], [mike, sat], [kate, sun]] as [string, string][]) {
    run(`INSERT OR IGNORE INTO attendance (id, location_id, user_id, status, going_date, visibility, created_at)
         VALUES (?,?,?, 'going', ?, 'public', ?)`, [id('att'), hollow, uid, date, now()]);
  }

  // a group with its chat
  if (!get(`SELECT id FROM groups WHERE name = 'Saturday Hollow Creek Crew'`)) {
    const gid = id('grp'), cid = id('cht');
    run(`INSERT INTO groups (id, name, description, location_id, planned_date, visibility, max_members, invite_code, created_by, created_at)
         VALUES (?,?,?,?,?, 'private', 8, 'HOLLOW42', ?, ?)`,
      [gid, 'Saturday Hollow Creek Crew', 'Meeting at the gravel lot at 7. Boots. Do not be the person in sneakers.', hollow, sat, jake, now()]);
    run('INSERT INTO chats (id, kind, group_id, title, created_at) VALUES (?,?,?,?,?)', [cid, 'group', gid, 'Saturday Hollow Creek Crew', now()]);
    for (const uid of [jake, sarah, mike]) {
      run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)', [gid, uid, uid === jake ? 'owner' : 'member', now()]);
      run('INSERT INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [cid, uid, 'active', now()]);
    }
    run(`INSERT INTO messages (id, chat_id, user_id, body, moderation_status, created_at) VALUES (?,?,?,?, 'approved', ?)`,
        [id('msg'), cid, jake, 'Gravel lot, 7pm sharp. Tickets are timed so we cannot be late.', now()]);
  }

  // thrill reports + reviews
  const reports: [string, string, any][] = [
    [jake, 'hollow-creek-haunted-woods', { fear: 9, paranormal: 7, isolation: 8, darkness: 10, difficulty: 6, value: 8, overall: 9, would_return: 1, body: 'Act six is the one that gets people. The trail is genuinely dark between sets — bring boots, the back half was ankle-deep after Thursday rain. Staff kept everything tight and safe. Absolutely terrifying in the best way.' }],
    [kate, 'blackwater-ridge-primitive-camp', { fear: 4, paranormal: 6, isolation: 10, darkness: 9, difficulty: 5, value: 9, overall: 9, would_return: 1, body: 'Zero signal past the first ridge, which is the entire point. Pack water — there is none. Heard something big moving at 2am and have decided it was a deer.' }],
    [mike, 'the-drover-hotel-paranormal-investigation', { fear: 7, paranormal: 10, isolation: 3, darkness: 9, difficulty: 2, value: 8, overall: 9, would_return: 1, body: 'Skeptic here. Still cannot explain the fourth-floor audio. Guides were professional and never once suggested wandering off on our own.' }],
    [sarah, 'sandhills-dark-sky-overlook', { fear: 3, paranormal: 4, isolation: 9, darkness: 10, difficulty: 3, value: 10, overall: 10, would_return: 1, body: 'Best sky I have seen in this state. The rim is unfenced — stay back from the edge and bring more light than you think you need.' }],
  ];
  for (const [uid, slug, r] of reports) {
    const lid = get<any>('SELECT id FROM locations WHERE slug = ?', [slug])?.id;
    if (!lid) continue;
    run(`INSERT INTO thrill_reports (id, location_id, user_id, visited_on, fear, paranormal, isolation, darkness, difficulty, value, overall, would_return, body, moderation_status, like_count, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved', ?, ?)`,
      [id('trp'), lid, uid, new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), r.fear, r.paranormal, r.isolation,
       r.darkness, r.difficulty, r.value, r.overall, r.would_return, r.body, Math.floor(Math.random() * 40) + 5, now()]);
    run(`INSERT INTO reviews (id, location_id, user_id, rating, body, moderation_status, created_at) VALUES (?,?,?,?,?, 'approved', ?)`,
      [id('rev'), lid, uid, Math.min(5, Math.round(r.overall / 2)), 'Worth the drive. Check the operator for current hours before you go.', now()]);
    run(`INSERT OR IGNORE INTO attendance (id, location_id, user_id, status, going_date, visibility, created_at)
         VALUES (?,?,?, 'completed', ?, 'public', ?)`, [id('att'), lid, uid, new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), now()]);
  }

  // mystery drop (never points at restricted property)
  if (!get('SELECT id FROM mystery_drops WHERE ends_at > ?', [now()])) {
    const target = get<any>(`SELECT id FROM locations WHERE slug = 'blackwater-ridge-primitive-camp'`)!.id;
    run(`INSERT INTO mystery_drops (id, location_id, teaser, fear_flames, group_min, group_max, radius_miles, pro_only, starts_at, ends_at, created_at)
         VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      [id('drop'), target, "We've found something within 100 miles. No signal. No lights. No neighbours.", 5, 3, 6, 100, now(), plusHours(72), now()]);
  }
});

// default admin-editable config rows so the admin UI has something to show
setCfg('pro.plan', (await import('../src/config.ts')).CONFIG_DEFAULTS['pro.plan']);
setCfg('uploads.limits', (await import('../src/config.ts')).CONFIG_DEFAULTS['uploads.limits']);
setCfg('moderation.enforcement', (await import('../src/config.ts')).CONFIG_DEFAULTS['moderation.enforcement']);

console.log('✅ Seeded THRILLHUNT demo data');
console.log('   Demo users (password: DemoPass!2026):');
USERS.forEach((u) => console.log(`     ${u.email.padEnd(34)} @${u.username}${u.pro ? '  [PRO]' : '  [FREE]'}`));
console.log('   Admin: admin@thrillhunt.test / AdminPass!2026');
console.log('   Mod  : mod@thrillhunt.test   / AdminPass!2026');