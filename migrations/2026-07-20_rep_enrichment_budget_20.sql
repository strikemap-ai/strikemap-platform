-- $5 was a placeholder guess before real Clay costs existed. Now that email lookups are $0.30
-- each (see CLAY_COST_PER_FIELD in enrichmentService.js), $20/week supports real day-to-day rep
-- usage (~66 email lookups/week at current active-field pricing) without being unlimited.
alter table reps alter column weekly_enrichment_budget set default 20;

update reps set weekly_enrichment_budget = 20 where weekly_enrichment_budget = 5;
