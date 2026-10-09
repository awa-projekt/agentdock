ALTER TABLE `agents` ADD `color` text DEFAULT '#2563eb' NOT NULL;--> statement-breakpoint
UPDATE `agents`
SET `color` = CASE abs(random()) % 8
  WHEN 0 THEN '#2563eb'
  WHEN 1 THEN '#7c3aed'
  WHEN 2 THEN '#db2777'
  WHEN 3 THEN '#dc2626'
  WHEN 4 THEN '#ea580c'
  WHEN 5 THEN '#ca8a04'
  WHEN 6 THEN '#16a34a'
  ELSE '#0891b2'
END;
