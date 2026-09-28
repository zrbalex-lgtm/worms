// Shared constants for simulation, rendering and networking.

export const WORLD = {
  W: 2600,          // map width in world pixels
  H: 1100,          // map height in world pixels
  WATER_Y: 1020,    // water surface; anything below this line drowns
};

export const PHYS = {
  GRAVITY: 520,         // px/s^2
  WORM_R: 8,            // worm collision radius
  WALK_SPEED: 62,       // px/s
  MAX_CLIMB: 4,         // max pixels a worm can step up per pixel walked
  MAX_STEP_DOWN: 6,     // max pixels a worm follows the ground downwards before falling
  JUMP_VX: 120,
  JUMP_VY: -255,
  FALL_SAFE: 90,        // falls shorter than this (px) are harmless
  FALL_DMG_PER_PX: 0.25,
  FALL_DMG_MAX: 40,
  BOUNCE: 0.35,         // restitution for knocked-back worms
  LAND_SPEED: 170,      // knocked worms land (stop bouncing) below this speed
};

export const TURN = {
  RETREAT: 3,           // seconds of movement allowed after firing
  SETTLE_MIN: 0.8,      // minimum pause between turns
  SETTLE_MAX: 12,       // safety timeout for the settle phase
};

export const NET = {
  PEER_PREFIX: 'wiggle-wars-v1-',
  SNAPSHOT_EVERY: 3,    // send a snapshot every N sim steps (60 Hz / 3 = 20 Hz)
  INTERP_DELAY: 0.1,    // seconds clients render behind the host
  PING_EVERY: 1500,     // ms
  TIMEOUT: 9000,        // ms without any message => peer considered gone
  MAX_PLAYERS: 4,
  TERRAIN_CHUNK: 12000, // characters per terrain chunk message
};

export const SIM_STEP = 1 / 60;

export const TEAM_COLORS = ['#ff4b4b', '#3aa2ff', '#ffd23a', '#d36bff'];
export const TEAM_LABELS = ['Red', 'Blue', 'Yellow', 'Purple'];

export const WORM_NAMES = [
  'Boggy', 'Spadge', 'Chuck', 'Nibbles', 'Wormo', 'Slinky', 'Squirm', 'Gary',
  'Pickles', 'Doug', 'Noodle', 'Fuzz', 'Waldo', 'Bert', 'Munch', 'Wiggles',
  'Sprout', 'Dirk', 'Clod', 'Mudge', 'Pip', 'Gus', 'Loopy', 'Scrunch',
  'Tater', 'Bubba', 'Ziggy', 'Rolo', 'Dusty', 'Nugget', 'Bingo', 'Chomp',
  'Sid', 'Wendel', 'Grub', 'Pogo', 'Taffy', 'Mo', 'Spud', 'Twiggy',
];

export const DEFAULT_SETTINGS = { wormsPerTeam: 4, turnTime: 45, hp: 100 };
