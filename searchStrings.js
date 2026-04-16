// searchStrings.js — All domain search queries by category
'use strict';

// Standard coverage domains (no minimum floor)
const STANDARD_DOMAINS = {
  running_physiology: {
    label: 'Running Physiology',
    minPapers: 0,
    queries: [
      'running economy',
      'VO2max running',
      'lactate threshold running',
      'endurance running training',
    ],
  },
  cycling_physiology: {
    label: 'Cycling Physiology',
    minPapers: 0,
    queries: [
      'cycling power output',
      'cycling VO2max',
      'FTP training cycling',
      'road cycling performance',
    ],
  },
  triathlon_performance: {
    label: 'Triathlon Performance',
    minPapers: 0,
    queries: [
      'triathlon physiology',
      'Ironman performance',
      'triathlon training load',
      'brick training triathlon',
    ],
  },
  nutrition_timing: {
    label: 'Nutrition Timing',
    minPapers: 0,
    queries: [
      'carbohydrate periodization',
      'race day fueling endurance',
      'glycogen resynthesis exercise',
      'pre-exercise nutrition performance',
    ],
  },
  injury_prevention: {
    label: 'Injury Prevention',
    minPapers: 0,
    queries: [
      'running injury prevention',
      'stress fracture endurance',
      'IT band syndrome runners',
      'Achilles tendinopathy running',
    ],
  },
  biomechanics: {
    label: 'Biomechanics',
    minPapers: 0,
    queries: [
      'running cadence biomechanics',
      'stride length running',
      'foot strike pattern running',
      'running economy biomechanics',
    ],
  },
  periodization: {
    label: 'Periodization',
    minPapers: 0,
    queries: [
      'polarized training endurance',
      'block periodization sport',
      'pyramidal training distribution',
      'training intensity distribution',
    ],
  },
  tapering_peaking: {
    label: 'Tapering & Peaking',
    minPapers: 0,
    queries: [
      'taper endurance athlete',
      'race week training',
      'peaking performance endurance',
      'pre-race preparation athlete',
    ],
  },
  deload_recovery: {
    label: 'Deload & Recovery',
    minPapers: 0,
    queries: [
      'recovery week training',
      'deload protocol endurance',
      'training stress balance',
      'supercompensation endurance',
    ],
  },
};

// Priority domains (minimum paper floors enforced)
const PRIORITY_DOMAINS = {
  trail_running_ultra: {
    label: 'Trail Running & Ultramarathon',
    minPapers: 20,
    queries: [
      'trail running physiology',
      'ultramarathon performance',
      'mountain running physiology',
      'ultra-endurance fatigue',
      'UTMB race analysis',
      'vertical kilometer running',
      'technical terrain running',
      'downhill running muscle damage',
      'ultra-trail nutrition',
      '100 mile race physiology',
    ],
  },
  female_athlete: {
    label: 'Female Athlete Physiology',
    minPapers: 15,
    queries: [
      'female endurance athlete physiology',
      'menstrual cycle exercise performance',
      'hormonal contraception sport',
      'RED-S female athlete',
      'estrogen athletic performance',
      'female running physiology',
      'sex differences endurance',
    ],
  },
  masters_athletes: {
    label: 'Masters Athletes (40+)',
    minPapers: 15,
    queries: [
      'masters athlete physiology',
      'aging endurance performance',
      'veteran runner performance',
      'masters cycling performance',
      'age-related VO2max decline',
      'older athlete training load',
      'masters triathlete',
    ],
  },
  sleep_recovery: {
    label: 'Sleep & Recovery Science',
    minPapers: 15,
    queries: [
      'sleep athletic performance',
      'HRV training readiness',
      'sleep deprivation sport performance',
      'recovery monitoring athlete',
      'sleep quality endurance',
      'sleep extension athletes',
    ],
  },
  mental_performance: {
    label: 'Mental Performance',
    minPapers: 10,
    queries: [
      'sport psychology endurance',
      'race anxiety performance',
      'mental fatigue running',
      'motivation endurance sport',
      'psychological skills training',
      'perceived exertion mental',
    ],
  },
  gut_training: {
    label: 'Gut Training & GI Distress',
    minPapers: 10,
    queries: [
      'gastrointestinal distress exercise',
      'gut training endurance',
      'exercise-induced GI problems',
      'carbohydrate absorption training',
      "runner's gut",
      'GI issues marathon',
    ],
  },
  wearable_data: {
    label: 'Wearable Data Interpretation',
    minPapers: 10,
    queries: [
      'HRV training load wearable',
      'wearable sensor sport performance',
      'heart rate variability athletes',
      'GPS training load endurance',
      'training stress score athlete',
      'readiness score athlete',
    ],
  },
  environmental_physiology: {
    label: 'Environmental Physiology',
    minPapers: 10,
    queries: [
      'heat acclimatization sport',
      'cold weather running performance',
      'altitude training endurance',
      'humidity athletic performance',
      'heat stress exercise',
      'thermoregulation athlete',
    ],
  },
  strength_endurance: {
    label: 'Strength Training for Endurance',
    minPapers: 10,
    queries: [
      'strength training running economy',
      'concurrent training endurance',
      'resistance training cyclist',
      'plyometric endurance athlete',
      'heavy strength endurance performance',
    ],
  },
  youth_athletes: {
    label: 'Youth & Junior Athletes',
    minPapers: 6,
    queries: [
      'youth endurance athlete development',
      'adolescent running performance',
      'junior cyclist development',
      'growth plate sport injury',
      'early sport specialization',
      'pediatric VO2max',
    ],
  },
};

const ALL_DOMAINS = { ...STANDARD_DOMAINS, ...PRIORITY_DOMAINS };

function getDomainKeys() {
  return Object.keys(ALL_DOMAINS);
}

function getPriorityDomainKeys() {
  return Object.keys(PRIORITY_DOMAINS);
}

function getQueriesForDomain(domainKey) {
  const domain = ALL_DOMAINS[domainKey];
  return domain ? domain.queries : [];
}

function getDomainLabel(domainKey) {
  const domain = ALL_DOMAINS[domainKey];
  return domain ? domain.label : domainKey;
}

function getDomainMinPapers(domainKey) {
  const domain = ALL_DOMAINS[domainKey];
  return domain ? domain.minPapers : 0;
}

module.exports = {
  STANDARD_DOMAINS,
  PRIORITY_DOMAINS,
  ALL_DOMAINS,
  getDomainKeys,
  getPriorityDomainKeys,
  getQueriesForDomain,
  getDomainLabel,
  getDomainMinPapers,
};
