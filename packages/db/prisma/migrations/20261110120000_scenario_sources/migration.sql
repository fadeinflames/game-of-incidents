-- Public postmortems a scenario is based on: [{title, url}], shown under the debrief once the session is over.
ALTER TABLE "Scenario" ADD COLUMN "sourcesJson" JSONB NOT NULL DEFAULT '[]';
