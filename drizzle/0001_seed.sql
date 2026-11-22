-- Default store walk order. Edit in Settings → Aisles.
INSERT OR IGNORE INTO aisles (name, sort) VALUES
  ('Produce', 10),
  ('Bakery', 20),
  ('Deli', 30),
  ('Meat & Seafood', 40),
  ('Dairy & Eggs', 50),
  ('Frozen', 60),
  ('Pantry', 70),
  ('Canned & Jarred', 80),
  ('Pasta & Grains', 90),
  ('Baking & Spices', 100),
  ('International', 110),
  ('Snacks', 120),
  ('Beverages', 130),
  ('Household', 140),
  ('Other', 1000);
--> statement-breakpoint
INSERT OR IGNORE INTO retailers (slug, name) VALUES
  ('target', 'Target'),
  ('amazon', 'Amazon'),
  ('costco', 'Costco');
--> statement-breakpoint
-- A sensible starting rule set; all editable or removable in Settings → Rules.
INSERT INTO plan_rules (name, kind, config_json, active, sort) VALUES
  ('No repeats within 2 weeks', 'no_repeat_within', '{"days":14}', 1, 10),
  ('Quick weeknights (Mon-Thu, 45 min)', 'weekday_max_time', '{"weekdays":[1,2,3,4],"max_total_min":45}', 0, 20),
  ('Taco Tuesday', 'weekday_theme', '{"weekday":2,"tag":"tacos"}', 0, 30),
  ('Pizza Friday', 'fixed_freeform', '{"weekday":5,"text":"Pizza night"}', 0, 40);
