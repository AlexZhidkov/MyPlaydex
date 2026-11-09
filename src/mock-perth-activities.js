/**
 * Realistic Mock Dataset of Greater Perth Amateur Sports Activities
 * Conforms strictly to MyPlaydex GLOSSARY.md domain entities, ADR 0001, and Issue 01 canonical schema.
 */

export const PERTH_SPORTS_CATEGORIES = [
  { id: 'all', name: 'All Sports', icon: '🏅' },
  { id: 'soccer', name: 'Soccer / Futsal', icon: '⚽' },
  { id: 'volleyball', name: 'Volleyball', icon: '🏐' },
  { id: 'basketball', name: 'Basketball', icon: '🏀' },
  { id: 'afl', name: 'AFL (Footy)', icon: '🏉' },
  { id: 'tennis', name: 'Tennis', icon: '🎾' },
  { id: 'pickleball', name: 'Pickleball', icon: '🏓' },
  { id: 'running', name: 'Running', icon: '🏃' },
  { id: 'social-fitness', name: 'Social Fitness', icon: '💪' },
  { id: 'walking', name: 'Walking', icon: '🚶' },
  { id: 'cricket', name: 'Cricket', icon: '🏏' },
  { id: 'other', name: 'Other / Multisport', icon: '🎯' }
];

export const MOCK_PERTH_ACTIVITIES = [
  {
    id: 'mock_futsal_loftus',
    region_id: 'perth',
    source: 'mock',
    source_id: 'futsal_loftus',
    source_url: 'https://loftusrec.com.au/futsal/social-monday',
    title: 'Monday Night Social Mixed Futsal',
    description: 'Weekly social mixed futsal league at Loftus Recreation Centre.',
    category: 'sports',
    subcategory: 'soccer',
    organizer: {
      id: 'org_leederville_social_futsal_club',
      name: 'Leederville Social Futsal Club'
    },
    venue: {
      id: 'venue_loftus_recreation_centre_qd66hd',
      name: 'Loftus Recreation Centre',
      coordinates: { lat: -31.936642, lng: 115.843105 },
      geohash: 'qd66hd16e'
    },
    schedule: {
      start_date: '2026-11-09',
      end_date: null,
      start_time: '18:30',
      end_time: '20:00',
      recurrence: 'weekly',
      day_of_week: 1
    },
    cost: {
      is_free: false,
      display_price: '$12 per player'
    },
    demographics: { gender: 'all', age: 'adults' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_beach_volleyball_scarborough',
    region_id: 'perth',
    source: 'mock',
    source_id: 'beach_volleyball_scarborough',
    source_url: 'https://volleyballwa.com.au/social-beach',
    title: 'Sunset Social Beach Volleyball Pickup',
    description: 'Sunset casual pickup volleyball on the sand courts at Scarborough Beach.',
    category: 'sports',
    subcategory: 'volleyball',
    organizer: {
      id: 'org_scarborough_beach_social_club',
      name: 'Scarborough Beach Social Club'
    },
    venue: {
      id: 'venue_scarborough_beach_amphitheatre_courts_qd66s4',
      name: 'Scarborough Beach Amphitheatre Courts',
      coordinates: { lat: -31.894218, lng: 115.75712 },
      geohash: 'qd66s4b9x'
    },
    schedule: {
      start_date: '2026-11-10',
      end_date: null,
      start_time: '17:30',
      end_time: '19:30',
      recurrence: 'weekly',
      day_of_week: 2
    },
    cost: {
      is_free: true,
      display_price: 'Free community session'
    },
    demographics: { gender: 'all', age: 'all' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_running_kings_park',
    region_id: 'perth',
    source: 'mock',
    source_id: 'running_kings_park',
    source_url: 'https://perthrunners.org.au/kings-park-5k',
    title: 'Sunrise Botanic Gardens Social 5K Run',
    description: 'Casual community 5K morning jog through Kings Park Botanic Gardens.',
    category: 'sports',
    subcategory: 'running',
    organizer: {
      id: 'org_perth_city_social_runners',
      name: 'Perth City Social Runners'
    },
    venue: {
      id: 'venue_kings_park_dna_tower_entrance_qd665c',
      name: 'Kings Park DNA Tower Entrance',
      coordinates: { lat: -31.961023, lng: 115.833014 },
      geohash: 'qd665c3e8'
    },
    schedule: {
      start_date: '2026-11-07',
      end_date: null,
      start_time: '06:30',
      end_time: '07:30',
      recurrence: 'weekly',
      day_of_week: 6
    },
    cost: {
      is_free: true,
      display_price: 'Free (Coffee after)'
    },
    demographics: { gender: 'all', age: 'adults' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_pickleball_south_perth',
    region_id: 'perth',
    source: 'mock',
    source_id: 'pickleball_south_perth',
    source_url: 'https://pickleballwa.org.au/south-perth-social',
    title: 'Twilight Riverview Social Pickleball',
    description: 'Open social pickleball doubles overlooking the Swan River skyline.',
    category: 'sports',
    subcategory: 'pickleball',
    organizer: {
      id: 'org_perth_metro_pickleball_club',
      name: 'Perth Metro Pickleball Club'
    },
    venue: {
      id: 'venue_south_perth_tennis_pickleball_centre_qd665f',
      name: 'South Perth Tennis & Pickleball Centre',
      coordinates: { lat: -31.975012, lng: 115.845032 },
      geohash: 'qd665f8g7'
    },
    schedule: {
      start_date: '2026-11-08',
      end_date: null,
      start_time: '16:00',
      end_time: '18:00',
      recurrence: 'weekly',
      day_of_week: 0
    },
    cost: {
      is_free: false,
      display_price: '$8 paddle & court hire'
    },
    demographics: { gender: 'all', age: 'all' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_tennis_robertson_park',
    region_id: 'perth',
    source: 'mock',
    source_id: 'tennis_robertson_park',
    source_url: 'https://robertsonparktennis.com.au/womens-social',
    title: 'Women Only Social Tennis & Drills',
    description: 'Weekly tennis drills, match play, and social coffee for women of all skill levels.',
    category: 'sports',
    subcategory: 'tennis',
    organizer: {
      id: 'org_robertson_park_tennis_club',
      name: 'Robertson Park Tennis Club'
    },
    venue: {
      id: 'venue_robertson_park_tennis_centre_qd66he',
      name: 'Robertson Park Tennis Centre',
      coordinates: { lat: -31.941203, lng: 115.857418 },
      geohash: 'qd66hed52'
    },
    schedule: {
      start_date: '2026-11-11',
      end_date: null,
      start_time: '09:00',
      end_time: '10:30',
      recurrence: 'weekly',
      day_of_week: 3
    },
    cost: {
      is_free: false,
      display_price: '$15 inclusive coaching & balls'
    },
    demographics: { gender: 'women_only', age: 'adults' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_basketball_jolimont',
    region_id: 'perth',
    source: 'mock',
    source_id: 'basketball_jolimont',
    source_url: 'https://perthhoops.com.au/runs',
    title: 'Open Pickup Run (Men Only - Full Court)',
    description: 'Competitive 5v5 full court basketball open run for men.',
    category: 'sports',
    subcategory: 'basketball',
    organizer: {
      id: 'org_western_suburbs_hoops_league',
      name: 'Western Suburbs Hoops League'
    },
    venue: {
      id: 'venue_state_netball_sports_centre_qd664w',
      name: 'State Netball & Sports Centre',
      coordinates: { lat: -31.945829, lng: 115.798144 },
      geohash: 'qd664we6q'
    },
    schedule: {
      start_date: '2026-11-07',
      end_date: null,
      start_time: '14:00',
      end_time: '16:00',
      recurrence: 'weekly',
      day_of_week: 6
    },
    cost: {
      is_free: false,
      display_price: '$10 court fee'
    },
    demographics: { gender: 'men_only', age: 'adults' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_afl9s_mount_claremont',
    region_id: 'perth',
    source: 'mock',
    source_id: 'afl9s_mount_claremont',
    source_url: 'https://play.afl/social/afl9s-perth',
    title: 'Saturday Social AFL 9s Mixed League',
    description: 'Touch-rules non-contact Australian Rules football for mixed gender teams.',
    category: 'sports',
    subcategory: 'afl',
    organizer: {
      id: 'org_uwa_afl_9s_community_club',
      name: 'UWA AFL 9s Community Club'
    },
    venue: {
      id: 'venue_uwa_sports_park_oval_qd664k',
      name: 'UWA Sports Park Oval',
      coordinates: { lat: -31.968412, lng: 115.783115 },
      geohash: 'qd664k42y'
    },
    schedule: {
      start_date: '2026-11-07',
      end_date: null,
      start_time: '10:00',
      end_time: '12:00',
      recurrence: 'weekly',
      day_of_week: 6
    },
    cost: {
      is_free: true,
      display_price: 'Free taster session ($5 ongoing)'
    },
    demographics: { gender: 'all', age: 'all' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_walking_lake_monger',
    region_id: 'perth',
    source: 'mock',
    source_id: 'walking_lake_monger',
    source_url: 'https://cambridge.wa.gov.au/community-walks',
    title: 'Lake Monger Masters Gentle Walking Group',
    description: 'Scenic lakeside loop walk tailored for seniors and masters (35+).',
    category: 'sports',
    subcategory: 'walking',
    organizer: {
      id: 'org_town_of_cambridge_walking_club',
      name: 'Town of Cambridge Walking Club'
    },
    venue: {
      id: 'venue_lake_monger_recreation_reserve_qd66h8',
      name: 'Lake Monger Recreation Reserve',
      coordinates: { lat: -31.931205, lng: 115.827391 },
      geohash: 'qd66h8r4m'
    },
    schedule: {
      start_date: '2026-11-08',
      end_date: null,
      start_time: '08:00',
      end_time: '09:15',
      recurrence: 'weekly',
      day_of_week: 0
    },
    cost: {
      is_free: true,
      display_price: 'Free'
    },
    demographics: { gender: 'all', age: 'masters' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_cricket_fremantle',
    region_id: 'perth',
    source: 'mock',
    source_id: 'cricket_fremantle',
    source_url: 'https://fremantlesports.org/tape-ball',
    title: 'Esplanade Park Social Tape-Ball Cricket',
    description: 'Casual community tape-ball cricket match on Fremantle Esplanade grass.',
    category: 'sports',
    subcategory: 'cricket',
    organizer: {
      id: 'org_fremantle_community_sports_club',
      name: 'Fremantle Community Sports Club'
    },
    venue: {
      id: 'venue_fremantle_esplanade_park_qd639u',
      name: 'Fremantle Esplanade Park',
      coordinates: { lat: -32.056912, lng: 115.743912 },
      geohash: 'qd639u9b7'
    },
    schedule: {
      start_date: '2026-11-08',
      end_date: null,
      start_time: '13:30',
      end_time: '16:30',
      recurrence: 'weekly',
      day_of_week: 0
    },
    cost: {
      is_free: true,
      display_price: 'Free (BYO bat if you have one)'
    },
    demographics: { gender: 'all', age: 'all' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_fitness_beatty_park',
    region_id: 'perth',
    source: 'mock',
    source_id: 'fitness_beatty_park',
    source_url: 'https://beattypark.com.au/outdoor-fitness',
    title: 'Outdoor Functional Calisthenics & Fitness',
    description: 'Open air bodyweight fitness and calisthenics training session.',
    category: 'sports',
    subcategory: 'social-fitness',
    organizer: {
      id: 'org_city_of_vincent_community_fitness',
      name: 'City of Vincent Community Fitness'
    },
    venue: {
      id: 'venue_beatty_park_outdoor_fitness_park_qd66hf',
      name: 'Beatty Park Outdoor Fitness Park',
      coordinates: { lat: -31.933214, lng: 115.848821 },
      geohash: 'qd66hf5h3'
    },
    schedule: {
      start_date: '2026-11-09',
      end_date: null,
      start_time: '07:00',
      end_time: '08:00',
      recurrence: 'weekly',
      day_of_week: 1
    },
    cost: {
      is_free: false,
      display_price: '$5 gold coin donation'
    },
    demographics: { gender: 'all', age: 'adults' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_multisport_manning',
    region_id: 'perth',
    source: 'mock',
    source_id: 'multisport_manning',
    source_url: 'https://southperth.wa.gov.au/manning-hub',
    title: 'Manning Community Centre Social Badminton & Table Tennis',
    description: 'Indoor recreational badminton and table tennis session for all abilities.',
    category: 'sports',
    subcategory: 'other',
    organizer: {
      id: 'org_south_perth_multisport_hub',
      name: 'South Perth Multisport Hub'
    },
    venue: {
      id: 'venue_manning_community_hub_qd666e',
      name: 'Manning Community Hub',
      coordinates: { lat: -32.008412, lng: 115.864319 },
      geohash: 'qd666e13m'
    },
    schedule: {
      start_date: '2026-11-12',
      end_date: null,
      start_time: '19:00',
      end_time: '21:00',
      recurrence: 'weekly',
      day_of_week: 4
    },
    cost: {
      is_free: false,
      display_price: '$7 venue fee'
    },
    demographics: { gender: 'all', age: 'adults' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_junior_cricket_subiaco',
    region_id: 'perth',
    source: 'mock',
    source_id: 'junior_cricket_subiaco',
    source_url: 'https://subiacocricket.org.au/juniors',
    title: 'Subiaco Junior Cricket Skills & Fun Match (<18)',
    description: 'Grassroots cricket coaching drills and friendly match for children and youth under 18.',
    category: 'sports',
    subcategory: 'cricket',
    organizer: {
      id: 'org_subiaco_junior_sports_club',
      name: 'Subiaco Junior Sports Club'
    },
    venue: {
      id: 'venue_subiaco_common_reserve_qd66h9',
      name: 'Subiaco Common Reserve',
      coordinates: { lat: -31.948212, lng: 115.823901 },
      geohash: 'qd66h9m2q'
    },
    schedule: {
      start_date: '2026-11-14',
      end_date: null,
      start_time: '09:00',
      end_time: '11:00',
      recurrence: 'weekly',
      day_of_week: 6
    },
    cost: {
      is_free: true,
      display_price: 'Free community session'
    },
    demographics: { gender: 'all', age: 'juniors' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'mock_beach_volleyball_citybeach',
    region_id: 'perth',
    source: 'mock',
    source_id: 'beach_volleyball_citybeach',
    source_url: 'https://volleyballwa.com.au/city-beach',
    title: 'City Beach Morning Sand Volleyball Drills',
    description: 'Structured beach volleyball ball-handling and conditioning drills on the sand.',
    category: 'sports',
    subcategory: 'volleyball',
    organizer: {
      id: 'org_west_coast_beach_volleyball',
      name: 'West Coast Beach Volleyball'
    },
    venue: {
      id: 'venue_city_beach_volleyball_pitches_qd667c',
      name: 'City Beach Volleyball Pitches',
      coordinates: { lat: -31.935102, lng: 115.753891 },
      geohash: 'qd667c29v'
    },
    schedule: {
      start_date: '2026-11-14',
      end_date: null,
      start_time: '08:00',
      end_time: '10:00',
      recurrence: 'weekly',
      day_of_week: 6
    },
    cost: {
      is_free: false,
      display_price: '$10 court hire fee'
    },
    demographics: { gender: 'all', age: 'adults' },
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  }
];
