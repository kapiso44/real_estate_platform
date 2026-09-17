CREATE TABLE `offers` (
	`id` bigint NOT NULL,
	`source_url` varchar(512) NOT NULL,
	`transaction_type` varchar(8) NOT NULL,
	`title` varchar(300) NOT NULL,
	`description_clean` mediumtext,
	`description_hash` char(64),
	`price` decimal(12,2),
	`currency` char(3),
	`price_per_m2` decimal(10,2),
	`rent` decimal(8,2),
	`area_m2` decimal(6,2),
	`rooms` tinyint,
	`floor_num` tinyint,
	`floor_label` varchar(24),
	`floors_total` tinyint,
	`year_built` smallint,
	`market` varchar(16),
	`advertiser_type` varchar(16),
	`seller_name` varchar(200),
	`city` varchar(100) NOT NULL,
	`district` varchar(100),
	`street` varchar(200),
	`lat` decimal(9,6),
	`lng` decimal(9,6),
	`building_type` varchar(40),
	`building_material` varchar(40),
	`building_ownership` varchar(40),
	`construction_status` varchar(40),
	`heating` varchar(40),
	`windows_type` varchar(40),
	`photos` json NOT NULL,
	`photos_count` smallint NOT NULL,
	`photos_declared` smallint,
	`features` json NOT NULL,
	`price_notes` json NOT NULL,
	`quality_flags` json NOT NULL,
	`field_sources` json NOT NULL,
	`duplicate_group_id` varchar(64),
	`is_canonical` boolean NOT NULL DEFAULT true,
	`ai_summary` mediumtext,
	`is_promoted` boolean NOT NULL DEFAULT false,
	`published_at` timestamp,
	`modified_at` timestamp,
	`normalized_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `offers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `offers_raw` (
	`id` bigint NOT NULL,
	`source` varchar(16) NOT NULL DEFAULT 'otodom',
	`source_url` varchar(512) NOT NULL,
	`payload` json NOT NULL,
	`fetched_at` timestamp NOT NULL,
	`imported_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `offers_raw_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_offers_price` ON `offers` (`price`);--> statement-breakpoint
CREATE INDEX `idx_offers_area` ON `offers` (`area_m2`);--> statement-breakpoint
CREATE INDEX `idx_offers_price_per_m2` ON `offers` (`price_per_m2`);--> statement-breakpoint
CREATE INDEX `idx_offers_district` ON `offers` (`district`);--> statement-breakpoint
CREATE INDEX `idx_offers_rooms` ON `offers` (`rooms`);--> statement-breakpoint
CREATE INDEX `idx_offers_market` ON `offers` (`market`);--> statement-breakpoint
CREATE INDEX `idx_offers_canonical` ON `offers` (`is_canonical`);--> statement-breakpoint
CREATE INDEX `idx_offers_duplicate_group` ON `offers` (`duplicate_group_id`);--> statement-breakpoint
CREATE FULLTEXT INDEX `ft_offers_text` ON `offers` (`title`, `description_clean`, `ai_summary`);
