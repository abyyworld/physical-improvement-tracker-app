// 256 short, plain words for the pairing code: 4 of them, picked from a fingerprint of what both
// sides exchanged (pairing.ts), make 32 bits, easy to read out and compare.

export const WORDS: readonly string[] = [
  'acorn', 'anchor', 'apple', 'apron', 'arrow', 'badge', 'bagel', 'baker', 'bamboo', 'banjo', 'barn', 'basket', 'beach', 'beard',
  'bell', 'berry', 'bike', 'bird', 'blanket', 'bloom', 'boat', 'bolt', 'bone', 'book', 'boot', 'bottle', 'bowl', 'brick',
  'bridge', 'broom', 'brush', 'bucket', 'cabin', 'cable', 'cactus', 'cake', 'camel', 'camera', 'candle', 'canoe', 'canyon',
  'carpet', 'carrot', 'castle', 'cedar', 'chair', 'chalk', 'cheese', 'cherry', 'chess', 'chimney', 'cider', 'circus', 'cliff',
  'clock', 'cloud', 'clover', 'coast', 'cobra', 'coconut', 'comet', 'compass', 'cookie', 'coral', 'cotton', 'crab', 'crane',
  'crayon', 'crown', 'daisy', 'desert', 'diamond', 'dolphin', 'donkey', 'door', 'dragon', 'drum', 'duck', 'eagle', 'earth',
  'echo', 'elbow', 'ember', 'engine', 'falcon', 'feather', 'fence', 'fern', 'ferry', 'fiddle', 'field', 'finch', 'flag', 'flame',
  'flute', 'forest', 'fossil', 'fox', 'frog', 'frost', 'garden', 'garlic', 'gecko', 'ginger', 'glacier', 'glove', 'goat',
  'grape', 'guitar', 'hammer', 'harbor', 'hawk', 'hazel', 'helmet', 'hill', 'honey', 'horse', 'igloo', 'island', 'jacket',
  'jaguar', 'jelly', 'jungle', 'kayak', 'kettle', 'kite', 'koala', 'ladder', 'lagoon', 'lake', 'lamp', 'lantern', 'leaf',
  'lemon', 'lily', 'lion', 'lizard', 'llama', 'lobster', 'lotus', 'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon',
  'mint', 'mirror', 'mitten', 'monkey', 'moon', 'moose', 'motor', 'mouse', 'muffin', 'mushroom', 'nest', 'noodle', 'oak',
  'ocean', 'olive', 'onion', 'orange', 'orbit', 'otter', 'owl', 'oyster', 'paddle', 'palace', 'panda', 'paper', 'parrot',
  'peach', 'peanut', 'pearl', 'pebble', 'pencil', 'pepper', 'piano', 'pickle', 'pigeon', 'pillow', 'pine', 'planet', 'plum',
  'pocket', 'pony', 'potato', 'prism', 'puffin', 'pumpkin', 'puzzle', 'quartz', 'quilt', 'rabbit', 'radio', 'rain', 'raven',
  'reef', 'ribbon', 'river', 'robin', 'rocket', 'rope', 'rose', 'ruby', 'saddle', 'salmon', 'sand', 'scarf', 'shadow', 'shark',
  'sheep', 'shell', 'ship', 'silver', 'skate', 'sled', 'snail', 'snow', 'sofa', 'spider', 'spoon', 'squid', 'star', 'stone',
  'storm', 'sugar', 'swan', 'table', 'tent', 'tiger', 'tomato', 'torch', 'tower', 'tractor', 'train', 'tulip', 'tunnel',
  'turtle', 'umbrella', 'valley', 'velvet', 'violin', 'volcano', 'wagon', 'walnut', 'walrus', 'whale', 'wheat', 'willow',
  'window', 'winter', 'wolf', 'yacht', 'zebra'
];
