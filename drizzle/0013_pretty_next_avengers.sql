CREATE TABLE "extract_cache" (
	"kind" text NOT NULL,
	"hash" text NOT NULL,
	"result" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "extract_cache_kind_hash_pk" PRIMARY KEY("kind","hash")
);
