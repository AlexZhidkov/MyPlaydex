/**
 * Realistic Mock Dataset of Greater Perth Amateur Sports Activities
 * Conforms strictly to MyPlaydex GLOSSARY.md domain entities and Issue 03 taxonomy.
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
  { id: 'social_fitness', name: 'Social Fitness', icon: '💪' },
  { id: 'walking', name: 'Walking', icon: '🚶' },
  { id: 'cricket', name: 'Cricket', icon: '🏏' },
  { id: 'other', name: 'Other / Multisport', icon: '🎯' }
];

export const MOCK_PERTH_ACTIVITIES = [
  {
    id: 'act_futsal_loftus',
    title: 'Monday Night Social Mixed Futsal',
    sport: 'soccer',
    type: 'social',
    skill_level: 'all',
    venue: {
      name: 'Loftus Recreation Centre',
      address: '99 Loftus St, Leederville WA 6007',
      coordinates: { lat: -31.936642, lng: 115.843105 },
      geohash: 'qd66hd16e'
    },
    schedule: {
      start_time: '2026-11-09T18:30:00.000Z',
      end_time: '2026-11-09T20:00:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'monday', frequency: 1 }
    },
    club_ref: 'clubs/leederville_futsal_club',
    club_name: 'Leederville Social Futsal Club',
    external_url: 'https://loftusrec.com.au/futsal/social-monday',
    cost_description: '$12 per player',
    is_free: false,
    demographics: { gender: 'mixed', age: 'adults' }
  },
  {
    id: 'act_beach_volleyball_scarborough',
    title: 'Sunset Social Beach Volleyball Pickup',
    sport: 'volleyball',
    type: 'social',
    skill_level: 'all',
    venue: {
      name: 'Scarborough Beach Amphitheatre Courts',
      address: 'The Esplanade, Scarborough WA 6019',
      coordinates: { lat: -31.894218, lng: 115.75712 },
      geohash: 'qd66s4b9x'
    },
    schedule: {
      start_time: '2026-11-10T17:30:00.000Z',
      end_time: '2026-11-10T19:30:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'tuesday', frequency: 1 }
    },
    club_ref: 'clubs/scarborough_beach_sports',
    club_name: 'Scarborough Beach Social Club',
    external_url: 'https://volleyballwa.com.au/social-beach',
    cost_description: 'Free community session',
    is_free: true,
    demographics: { gender: 'mixed', age: 'all' }
  },
  {
    id: 'act_running_kings_park',
    title: 'Sunrise Botanic Gardens Social 5K Run',
    sport: 'running',
    type: 'social',
    skill_level: 'beginner',
    venue: {
      name: 'Kings Park DNA Tower Entrance',
      address: 'Fraser Ave, West Perth WA 6005',
      coordinates: { lat: -31.961023, lng: 115.833014 },
      geohash: 'qd665c3e8'
    },
    schedule: {
      start_time: '2026-11-07T06:30:00.000Z',
      end_time: '2026-11-07T07:30:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'saturday', frequency: 1 }
    },
    club_ref: 'clubs/perth_city_runners',
    club_name: 'Perth City Social Runners',
    external_url: 'https://perthrunners.org.au/kings-park-5k',
    cost_description: 'Free (Coffee after)',
    is_free: true,
    demographics: { gender: 'mixed', age: 'adults' }
  },
  {
    id: 'act_pickleball_south_perth',
    title: 'Twilight Riverview Social Pickleball',
    sport: 'pickleball',
    type: 'social',
    skill_level: 'all',
    venue: {
      name: 'South Perth Tennis & Pickleball Centre',
      address: 'Sir James Mitchell Park, South Perth WA 6151',
      coordinates: { lat: -31.975012, lng: 115.845032 },
      geohash: 'qd665f8g7'
    },
    schedule: {
      start_time: '2026-11-08T16:00:00.000Z',
      end_time: '2026-11-08T18:00:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'sunday', frequency: 1 }
    },
    club_ref: 'clubs/wa_pickleball_hub',
    club_name: 'Perth Metro Pickleball Club',
    external_url: 'https://pickleballwa.org.au/south-perth-social',
    cost_description: '$8 paddle & court hire',
    is_free: false,
    demographics: { gender: 'mixed', age: 'all' }
  },
  {
    id: 'act_tennis_robertson_park',
    title: 'Women Only Social Tennis & Drills',
    sport: 'tennis',
    type: 'training',
    skill_level: 'intermediate',
    venue: {
      name: 'Robertson Park Tennis Centre',
      address: '176 Fitzgerald St, Perth WA 6000',
      coordinates: { lat: -31.941203, lng: 115.857418 },
      geohash: 'qd66hed52'
    },
    schedule: {
      start_time: '2026-11-11T09:00:00.000Z',
      end_time: '2026-11-11T10:30:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'wednesday', frequency: 1 }
    },
    club_ref: 'clubs/north_perth_tennis',
    club_name: 'Robertson Park Tennis Club',
    external_url: 'https://robertsonparktennis.com.au/womens-social',
    cost_description: '$15 inclusive coaching & balls',
    is_free: false,
    demographics: { gender: 'women', age: 'adults' }
  },
  {
    id: 'act_basketball_jolimont',
    title: 'Open Pickup Run (Men Only - Full Court)',
    sport: 'basketball',
    type: 'game',
    skill_level: 'intermediate',
    venue: {
      name: 'State Netball & Sports Centre',
      address: '200 Selby St, Jolimont WA 6014',
      coordinates: { lat: -31.945829, lng: 115.798144 },
      geohash: 'qd664we6q'
    },
    schedule: {
      start_time: '2026-11-07T14:00:00.000Z',
      end_time: '2026-11-07T16:00:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'saturday', frequency: 1 }
    },
    club_ref: 'clubs/perth_hoops_collective',
    club_name: 'Western Suburbs Hoops League',
    external_url: 'https://perthhoops.com.au/runs',
    cost_description: '$10 court fee',
    is_free: false,
    demographics: { gender: 'men', age: 'adults' }
  },
  {
    id: 'act_afl9s_mount_claremont',
    title: 'Saturday Social AFL 9s Mixed League',
    sport: 'afl',
    type: 'game',
    skill_level: 'all',
    venue: {
      name: 'UWA Sports Park Oval',
      address: '10 McGillivray Rd, Mount Claremont WA 6010',
      coordinates: { lat: -31.968412, lng: 115.783115 },
      geohash: 'qd664k42y'
    },
    schedule: {
      start_time: '2026-11-07T10:00:00.000Z',
      end_time: '2026-11-07T12:00:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'saturday', frequency: 1 }
    },
    club_ref: 'clubs/uwa_social_footy',
    club_name: 'UWA AFL 9s Community Club',
    external_url: 'https://play.afl/social/afl9s-perth',
    cost_description: 'Free taster session ($5 ongoing)',
    is_free: true,
    demographics: { gender: 'mixed', age: 'all' }
  },
  {
    id: 'act_walking_lake_monger',
    title: 'Lake Monger Masters Gentle Walking Group',
    sport: 'walking',
    type: 'social',
    skill_level: 'beginner',
    venue: {
      name: 'Lake Monger Recreation Reserve',
      address: 'Gregory St, Wembley WA 6014',
      coordinates: { lat: -31.931205, lng: 115.827391 },
      geohash: 'qd66h8r4m'
    },
    schedule: {
      start_time: '2026-11-08T08:00:00.000Z',
      end_time: '2026-11-08T09:15:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'sunday', frequency: 1 }
    },
    club_ref: 'clubs/cambridge_walkers',
    club_name: 'Town of Cambridge Walking Club',
    external_url: 'https://cambridge.wa.gov.au/community-walks',
    cost_description: 'Free',
    is_free: true,
    demographics: { gender: 'mixed', age: 'masters' }
  },
  {
    id: 'act_cricket_fremantle',
    title: 'Esplanade Park Social Tape-Ball Cricket',
    sport: 'cricket',
    type: 'social',
    skill_level: 'all',
    venue: {
      name: 'Fremantle Esplanade Park',
      address: 'Marine Terrace, Fremantle WA 6160',
      coordinates: { lat: -32.056912, lng: 115.743912 },
      geohash: 'qd639u9b7'
    },
    schedule: {
      start_time: '2026-11-08T13:30:00.000Z',
      end_time: '2026-11-08T16:30:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'sunday', frequency: 1 }
    },
    club_ref: 'clubs/freo_community_cricket',
    club_name: 'Fremantle Community Sports Club',
    external_url: 'https://fremantlesports.org/tape-ball',
    cost_description: 'Free (BYO bat if you have one)',
    is_free: true,
    demographics: { gender: 'mixed', age: 'all' }
  },
  {
    id: 'act_fitness_beatty_park',
    title: 'Outdoor Functional Calisthenics & Fitness',
    sport: 'social_fitness',
    type: 'training',
    skill_level: 'all',
    venue: {
      name: 'Beatty Park Outdoor Fitness Park',
      address: '220 Vincent St, North Perth WA 6006',
      coordinates: { lat: -31.933214, lng: 115.848821 },
      geohash: 'qd66hf5h3'
    },
    schedule: {
      start_time: '2026-11-09T07:00:00.000Z',
      end_time: '2026-11-09T08:00:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'monday', frequency: 1 }
    },
    club_ref: 'clubs/vincent_fitness_crew',
    club_name: 'City of Vincent Community Fitness',
    external_url: 'https://beattypark.com.au/outdoor-fitness',
    cost_description: '$5 gold coin donation',
    is_free: false,
    demographics: { gender: 'mixed', age: 'adults' }
  },
  {
    id: 'act_multisport_manning',
    title: 'Manning Community Centre Social Badminton & Table Tennis',
    sport: 'other',
    type: 'social',
    skill_level: 'all',
    venue: {
      name: 'Manning Community Hub',
      address: '2 Conochie Cres, Manning WA 6152',
      coordinates: { lat: -32.008412, lng: 115.864319 },
      geohash: 'qd666e13m'
    },
    schedule: {
      start_time: '2026-11-12T19:00:00.000Z',
      end_time: '2026-11-12T21:00:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'thursday', frequency: 1 }
    },
    club_ref: 'clubs/manning_sports_hub',
    club_name: 'South Perth Multisport Hub',
    external_url: 'https://southperth.wa.gov.au/manning-hub',
    cost_description: '$7 hall entry',
    is_free: false,
    demographics: { gender: 'mixed', age: 'adults' }
  },
  {
    id: 'act_beach_volleyball_citybeach',
    title: 'City Beach Morning Sand Volleyball Drills',
    sport: 'volleyball',
    type: 'training',
    skill_level: 'intermediate',
    venue: {
      name: 'City Beach Volleyball Pitches',
      address: 'Challenger Parade, City Beach WA 6015',
      coordinates: { lat: -31.935102, lng: 115.753891 },
      geohash: 'qd667c29v'
    },
    schedule: {
      start_time: '2026-11-14T08:00:00.000Z',
      end_time: '2026-11-14T10:00:00.000Z',
      recurrence: { pattern: 'weekly', day_of_week: 'saturday', frequency: 1 }
    },
    club_ref: 'clubs/west_coast_sand_volleyball',
    club_name: 'West Coast Beach Volleyball',
    external_url: 'https://volleyballwa.com.au/city-beach',
    cost_description: '$10 coach fee',
    is_free: false,
    demographics: { gender: 'mixed', age: 'adults' }
  }
];
