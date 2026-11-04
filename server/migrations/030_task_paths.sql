-- Tasks with paths: questions to answer (each answer can ask another), ending in steps to work through.
-- path_state keeps which steps are finished and today's choice.
alter table events add column paths jsonb;
alter table events add column path_state jsonb;
