// A small, curated, profanity-screened wordlist for docId generation. Three
// words drawn from it (doc_brave-otter-canyon) give recognizable, collision-rare
// ids with zero dependency. Correctness never depends on entropy — collisions
// regenerate against the docId index — so this list is deliberately compact and
// kept to neutral, unambiguous nouns/adjectives.

export const WORDLIST: string[] = [
  "amber", "anchor", "apple", "arbor", "arrow", "aspen", "atlas", "aurora",
  "basil", "beacon", "birch", "bison", "blossom", "brave", "breeze", "bridge",
  "bright", "brook", "canyon", "cedar", "cinder", "clay", "clever", "cliff",
  "cloud", "clover", "comet", "coral", "cove", "crane", "crest", "crimson",
  "crystal", "dawn", "delta", "dune", "ember", "fable", "falcon", "fern",
  "fjord", "flint", "forest", "fox", "garnet", "glacier", "glade", "gold",
  "granite", "grove", "harbor", "hazel", "heron", "hollow", "indigo", "iris",
  "island", "ivory", "jade", "jasmine", "jetty", "juniper", "kelp", "lagoon",
  "lake", "lantern", "lark", "laurel", "ledger", "lily", "linen", "lotus",
  "lumen", "lunar", "maple", "marble", "meadow", "mesa", "mint", "mist",
  "moss", "mountain", "nectar", "nest", "noble", "north", "oak", "ocean",
  "olive", "onyx", "opal", "orchard", "otter", "pebble", "petal", "pine",
  "pixel", "plum", "pond", "poppy", "prairie", "quartz", "quiet", "quill",
  "rapid", "raven", "reef", "ridge", "river", "robin", "rowan", "ruby",
  "sage", "sand", "sapphire", "shore", "silver", "sky", "slate", "spark",
  "spruce", "starling", "stone", "summit", "swift", "tide", "timber", "topaz",
  "tulip", "tundra", "umber", "valley", "velvet", "vine", "violet", "willow",
  "wren", "zephyr",
];
