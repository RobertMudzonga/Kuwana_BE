-- PostgreSQL init script
-- Enables PostGIS extension required for geospatial queries on providers table
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- For fuzzy text search on service listings
