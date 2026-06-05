// Seed the index with REAL GTLL ecosystem agents — honest fingerprints,
// real endpoints. No sims, no padding. Registers via the live /register
// endpoint (inline path → verified:false) so each is embedded on the way in.
//
// These are the genuine product agents (real conversations endpoint) + the
// orbit model-router. soul-guide is already registered (verified) — not touched.

const BASE = process.env.OLW_BASE || 'http://localhost:3778';
const CONV = 'https://api.gtll.app/apps/69d31470a6053f325babdc66/agents/conversations';

const agents = [
  {
    address: 'trip-planner@gtll.olw',
    name: 'GTLL Trip Planner',
    description: 'Plans multi-night group trips end to end — builds itineraries, balances group preferences, sequences activities across nights.',
    endpoint: CONV,
    fingerprint: { domain: 'travel', task_types: ['itinerary_planning', 'group_coordination', 'activity_sequencing'],
      input_formats: ['text'], output_formats: ['json', 'text'], context_depth: 'deep', latency_class: 'standard', trust_level: 'open', soul_compatible: false },
    resonance: { signal: '555' },
  },
  {
    address: 'booking-agent@gtll.olw',
    name: 'GTLL Booking Agent',
    description: 'Turns a chosen plan into confirmed reservations — issues booking requests, tracks confirmation codes, handles auto-confirm.',
    endpoint: CONV,
    fingerprint: { domain: 'travel', task_types: ['reservation', 'booking_confirmation', 'availability_check'],
      input_formats: ['text', 'json'], output_formats: ['json'], context_depth: 'medium', latency_class: 'standard', trust_level: 'open', soul_compatible: false },
    resonance: { signal: '333' },
  },
  {
    address: 'guest-coordinator@gtll.olw',
    name: 'GTLL Guest Coordinator',
    description: 'Manages the guest list for an event — tracks RSVPs, votes, and announcements across the party.',
    endpoint: CONV,
    fingerprint: { domain: 'events', task_types: ['guest_management', 'rsvp_tracking', 'group_voting'],
      input_formats: ['text'], output_formats: ['json', 'text'], context_depth: 'deep', latency_class: 'standard', trust_level: 'open', soul_compatible: false },
    resonance: { signal: '333' },
  },
  {
    address: 'payment-chaser@gtll.olw',
    name: 'GTLL Payment Chaser',
    description: 'Collects money owed across a group — sends payment reminders, tracks who has paid, reconciles per-person amounts.',
    endpoint: CONV,
    fingerprint: { domain: 'payments', task_types: ['payment_collection', 'reminder', 'reconciliation'],
      input_formats: ['text', 'json'], output_formats: ['json'], context_depth: 'medium', latency_class: 'fast', trust_level: 'authenticated', soul_compatible: false },
    resonance: { signal: '777' },
  },
  {
    address: 'venue-coordinator@gtll.olw',
    name: 'GTLL Venue Coordinator',
    description: 'Matches groups to venues — searches by vibe, capacity, and budget, checks availability, surfaces min-spend.',
    endpoint: CONV,
    fingerprint: { domain: 'hospitality', task_types: ['venue_matching', 'availability_check', 'budget_filtering'],
      input_formats: ['text'], output_formats: ['json', 'text'], context_depth: 'medium', latency_class: 'standard', trust_level: 'open', soul_compatible: false },
    resonance: { signal: '555' },
  },
  {
    address: 'orbit-router@gtll.olw',
    name: 'ORBIT Model Router',
    description: 'Routes a request to the right LLM by signal and complexity — fast classification to cheap models, customer-facing reasoning to premium models, in real time.',
    endpoint: 'https://api.gtll.app/orbitRoute',
    fingerprint: { domain: 'ai-infrastructure', task_types: ['model_routing', 'signal_routing', 'cost_optimization'],
      input_formats: ['text', 'json'], output_formats: ['json'], context_depth: 'shallow', latency_class: 'realtime', trust_level: 'authenticated', soul_compatible: true },
    resonance: { signal: '777' },
  },
];

let ok = 0, err = 0;
for (const a of agents) {
  try {
    const r = await fetch(`${BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a),
    });
    const j = await r.json();
    if (r.ok && j.registered) { ok++; console.log(`✓ ${a.address}  [${a.resonance?.signal || '-'}]`); }
    else { err++; console.error(`✗ ${a.address}: ${JSON.stringify(j)}`); }
  } catch (e) { err++; console.error(`✗ ${a.address}: ${e.message}`); }
}
console.log(`\nseed: ${ok} registered, ${err} failed`);
