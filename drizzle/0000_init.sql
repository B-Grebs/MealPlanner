CREATE TABLE `aisles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aisles_name_unique` ON `aisles` (`name`);--> statement-breakpoint
CREATE TABLE `api_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`client_id` text NOT NULL,
	`scopes` text DEFAULT 'ha' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_clients_name_unique` ON `api_clients` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_clients_client_id_unique` ON `api_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `feed_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`revoked` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feed_tokens_token_hash_unique` ON `feed_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `ingest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer,
	`kind` text NOT NULL,
	`received` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`errors_json` text DEFAULT '[]' NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `api_clients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `ingredient_product_links` (
	`ingredient_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`preferred` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	PRIMARY KEY(`ingredient_id`, `product_id`),
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `store_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`aisle_id` integer,
	`is_staple` integer DEFAULT false NOT NULL,
	`default_unit` text,
	FOREIGN KEY (`aisle_id`) REFERENCES `aisles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingredients_name_uq` ON `ingredients` ("name" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `meal_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`parent_plan_id` integer,
	`last_seed` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `meal_plans_month_idx` ON `meal_plans` (`month`);--> statement-breakpoint
CREATE TABLE `plan_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`date` text NOT NULL,
	`slot` text DEFAULT 'dinner' NOT NULL,
	`recipe_id` integer,
	`freeform_text` text,
	`servings_override` integer,
	`locked` integer DEFAULT false NOT NULL,
	`notes` text,
	FOREIGN KEY (`plan_id`) REFERENCES `meal_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_entries_slot_uq` ON `plan_entries` (`plan_id`,`date`,`slot`);--> statement-breakpoint
CREATE INDEX `plan_entries_date_idx` ON `plan_entries` (`date`);--> statement-breakpoint
CREATE TABLE `plan_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`price_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`unit_price_cents` integer,
	`in_stock` integer,
	`store_ref` text,
	`observed_at` text NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `store_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_prices_obs_uq` ON `product_prices` (`product_id`,`observed_at`,`source`);--> statement-breakpoint
CREATE INDEX `product_prices_product_idx` ON `product_prices` (`product_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `purchase_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`line_key` text NOT NULL,
	`product_id` integer,
	`name` text NOT NULL,
	`qty` real DEFAULT 1 NOT NULL,
	`unit_price_cents` integer,
	`total_cents` integer,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `store_products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_items_line_uq` ON `purchase_items` (`purchase_id`,`line_key`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`retailer_id` integer NOT NULL,
	`external_order_id` text NOT NULL,
	`ordered_at` text NOT NULL,
	`total_cents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`source` text NOT NULL,
	`raw_json` text,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`retailer_id`) REFERENCES `retailers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_ext_uq` ON `purchases` (`retailer_id`,`external_order_id`);--> statement-breakpoint
CREATE INDEX `purchases_ordered_idx` ON `purchases` (`ordered_at`);--> statement-breakpoint
CREATE TABLE `recipe_ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`ingredient_id` integer NOT NULL,
	`qty` real,
	`unit` text DEFAULT '' NOT NULL,
	`note` text,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `recipe_ingredients_recipe_idx` ON `recipe_ingredients` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `recipe_tags` (
	`recipe_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`recipe_id`, `tag_id`),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`servings` integer DEFAULT 4 NOT NULL,
	`prep_min` integer,
	`cook_min` integer,
	`instructions_md` text,
	`source_url` text,
	`photo_key` text,
	`prep_note` text,
	`favorite` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recipes_title_idx` ON `recipes` (`title`);--> statement-breakpoint
CREATE TABLE `retailers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retailers_slug_unique` ON `retailers` (`slug`);--> statement-breakpoint
CREATE TABLE `shopping_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_id` integer NOT NULL,
	`ingredient_id` integer,
	`text` text NOT NULL,
	`qty` real,
	`unit` text DEFAULT '' NOT NULL,
	`aisle` text,
	`checked` integer DEFAULT false NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`source_entry_ids_json` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `shopping_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shopping_items_list_idx` ON `shopping_items` (`list_id`);--> statement-breakpoint
CREATE TABLE `shopping_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`include_staples` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `store_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`retailer_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`size_text` text,
	`pack_qty` real,
	`pack_unit` text,
	`upc` text,
	`url` text,
	`image_url` text,
	`source` text NOT NULL,
	`first_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`raw_json` text,
	FOREIGN KEY (`retailer_id`) REFERENCES `retailers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_products_ext_uq` ON `store_products` (`retailer_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `store_products_name_idx` ON `store_products` (`name`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_uq` ON `tags` ("name" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);