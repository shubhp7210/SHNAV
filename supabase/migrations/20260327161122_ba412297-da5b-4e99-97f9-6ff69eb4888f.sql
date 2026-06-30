-- Route Optimizer tables
CREATE TABLE public.routes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  flight_intent_id UUID REFERENCES public.flight_intents(id) ON DELETE SET NULL,
  aircraft_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  altitude_band TEXT NOT NULL,
  primary_route JSONB,
  alternate_routes JSONB,
  overall_score NUMERIC,
  safety_score NUMERIC,
  weather_score NUMERIC,
  traffic_score NUMERIC,
  efficiency_score NUMERIC,
  conflict_details JSONB,
  weather_conditions JSONB,
  weather_risk TEXT DEFAULT 'low',
  selection_reason TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read routes" ON public.routes FOR SELECT USING (true);
CREATE POLICY "Anyone can insert routes" ON public.routes FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update routes" ON public.routes FOR UPDATE USING (true);

CREATE TABLE public.route_patterns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  origin_key TEXT NOT NULL,
  destination_key TEXT NOT NULL,
  altitude_band TEXT NOT NULL,
  flight_count INTEGER DEFAULT 0,
  avg_overall_score NUMERIC DEFAULT 0,
  avg_safety_score NUMERIC DEFAULT 0,
  avg_weather_score NUMERIC DEFAULT 0,
  avg_traffic_score NUMERIC DEFAULT 0,
  avg_efficiency_score NUMERIC DEFAULT 0,
  preferred_waypoints JSONB,
  last_updated TIMESTAMPTZ DEFAULT now(),
  UNIQUE(origin_key, destination_key, altitude_band)
);
ALTER TABLE public.route_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read route_patterns" ON public.route_patterns FOR SELECT USING (true);
CREATE POLICY "Anyone can insert route_patterns" ON public.route_patterns FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update route_patterns" ON public.route_patterns FOR UPDATE USING (true);

CREATE TABLE public.route_score_config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  weight_safety NUMERIC DEFAULT 0.35,
  weight_weather NUMERIC DEFAULT 0.25,
  weight_traffic NUMERIC DEFAULT 0.25,
  weight_efficiency NUMERIC DEFAULT 0.15,
  min_safe_separation_km NUMERIC DEFAULT 0.5,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.route_score_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read route_score_config" ON public.route_score_config FOR SELECT USING (true);
CREATE POLICY "Anyone can insert route_score_config" ON public.route_score_config FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update route_score_config" ON public.route_score_config FOR UPDATE USING (true);
INSERT INTO public.route_score_config (weight_safety, weight_weather, weight_traffic, weight_efficiency, min_safe_separation_km) VALUES (0.35, 0.25, 0.25, 0.15, 0.5);

-- Add user_id to flight_intents
ALTER TABLE public.flight_intents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
DROP POLICY IF EXISTS "Anyone can read flight intents" ON public.flight_intents;
DROP POLICY IF EXISTS "Anyone can insert flight intents" ON public.flight_intents;
DROP POLICY IF EXISTS "Anyone can update flight intents" ON public.flight_intents;
CREATE POLICY "Users read own intents" ON public.flight_intents FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own intents" ON public.flight_intents FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own intents" ON public.flight_intents FOR UPDATE USING (auth.uid() = user_id);

-- Advanced ATM tables
CREATE TABLE public.airspace_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  altitude_band TEXT NOT NULL DEFAULT 'low',
  capacity_per_hour INTEGER NOT NULL DEFAULT 8,
  current_load INTEGER NOT NULL DEFAULT 0,
  is_no_fly BOOLEAN NOT NULL DEFAULT false,
  no_fly_reason TEXT,
  no_fly_start TIMESTAMPTZ,
  no_fly_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.time_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id UUID REFERENCES public.airspace_segments(id) ON DELETE CASCADE,
  flight_intent_id UUID REFERENCES public.flight_intents(id) ON DELETE CASCADE,
  aircraft_id TEXT NOT NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  priority INTEGER NOT NULL DEFAULT 40,
  status TEXT NOT NULL DEFAULT 'allocated' CHECK (status IN ('allocated','active','completed','cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.vertiports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  city TEXT,
  lat NUMERIC NOT NULL DEFAULT 0,
  lon NUMERIC NOT NULL DEFAULT 0,
  max_departures_per_hour INTEGER NOT NULL DEFAULT 4,
  max_arrivals_per_hour INTEGER NOT NULL DEFAULT 4,
  pad_count INTEGER NOT NULL DEFAULT 2,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.vertiport_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vertiport_id UUID REFERENCES public.vertiports(id) ON DELETE CASCADE,
  flight_intent_id UUID REFERENCES public.flight_intents(id) ON DELETE CASCADE,
  aircraft_id TEXT NOT NULL,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('departure','arrival')),
  scheduled_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','completed','cancelled','delayed')),
  delay_minutes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.flight_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_intent_id UUID REFERENCES public.flight_intents(id) ON DELETE CASCADE,
  aircraft_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('GO','DELAY','REROUTE')),
  reason TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 80 CHECK (confidence BETWEEN 0 AND 100),
  departure_time TIMESTAMPTZ,
  delay_minutes INTEGER DEFAULT 0,
  route_id UUID REFERENCES public.routes(id) ON DELETE SET NULL,
  simulation_result JSONB,
  weather_risk TEXT DEFAULT 'low',
  airspace_load INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.trajectory_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_intent_id UUID REFERENCES public.flight_intents(id) ON DELETE CASCADE,
  aircraft_id TEXT NOT NULL,
  lat NUMERIC NOT NULL,
  lon NUMERIC NOT NULL,
  altitude_ft INTEGER NOT NULL DEFAULT 500,
  speed_kmh NUMERIC NOT NULL DEFAULT 90,
  heading_deg NUMERIC DEFAULT 0,
  is_on_route BOOLEAN DEFAULT true,
  deviation_meters NUMERIC DEFAULT 0,
  battery_pct NUMERIC DEFAULT 100,
  recorded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_intent_id UUID REFERENCES public.flight_intents(id) ON DELETE CASCADE,
  aircraft_id TEXT NOT NULL,
  anomaly_type TEXT NOT NULL CHECK (anomaly_type IN ('route_deviation','unexpected_slowdown','battery_risk','weather_spike','airspace_breach','conflict_proximity')),
  severity TEXT NOT NULL DEFAULT 'moderate' CHECK (severity IN ('low','moderate','high','critical')),
  description TEXT NOT NULL,
  lat NUMERIC,
  lon NUMERIC,
  detected_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true
);

-- RLS for ATM tables
ALTER TABLE public.airspace_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vertiports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vertiport_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trajectory_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anomalies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read airspace_segments" ON public.airspace_segments FOR SELECT USING (true);
CREATE POLICY "Service can manage airspace_segments" ON public.airspace_segments FOR ALL USING (true);

CREATE POLICY "Anyone can read time_slots" ON public.time_slots FOR SELECT USING (true);
CREATE POLICY "Service can manage time_slots" ON public.time_slots FOR ALL USING (true);

CREATE POLICY "Anyone can read vertiports" ON public.vertiports FOR SELECT USING (true);
CREATE POLICY "Service can manage vertiports" ON public.vertiports FOR ALL USING (true);

CREATE POLICY "Anyone can read vertiport_slots" ON public.vertiport_slots FOR SELECT USING (true);
CREATE POLICY "Service can manage vertiport_slots" ON public.vertiport_slots FOR ALL USING (true);

CREATE POLICY "Anyone can read flight_decisions" ON public.flight_decisions FOR SELECT USING (true);
CREATE POLICY "Service can manage flight_decisions" ON public.flight_decisions FOR ALL USING (true);

CREATE POLICY "Anyone can read trajectory_updates" ON public.trajectory_updates FOR SELECT USING (true);
CREATE POLICY "Service can manage trajectory_updates" ON public.trajectory_updates FOR ALL USING (true);

CREATE POLICY "Anyone can read anomalies" ON public.anomalies FOR SELECT USING (true);
CREATE POLICY "Service can manage anomalies" ON public.anomalies FOR ALL USING (true);

-- Seed vertiports
INSERT INTO public.vertiports (name, city, lat, lon, max_departures_per_hour, max_arrivals_per_hour, pad_count) VALUES
  ('Downtown Vertiport', 'City Center', 40.7128, -74.0060, 6, 6, 3),
  ('Airport Vertiport North', 'North District', 40.7580, -73.9855, 8, 8, 4),
  ('Bay Vertiport', 'Waterfront', 40.6892, -74.0445, 4, 4, 2),
  ('Uptown Hub', 'Uptown', 40.7831, -73.9712, 5, 5, 3),
  ('East Corridor Hub', 'East Side', 40.7282, -73.9442, 4, 4, 2);

-- Seed airspace segments
INSERT INTO public.airspace_segments (name, altitude_band, capacity_per_hour) VALUES
  ('North Corridor', 'low', 8),
  ('North Corridor', 'mid', 10),
  ('North Corridor', 'high', 6),
  ('South Corridor', 'low', 8),
  ('South Corridor', 'mid', 10),
  ('East Corridor', 'low', 6),
  ('East Corridor', 'mid', 8),
  ('West Corridor', 'low', 6),
  ('Central Hub', 'low', 12),
  ('Central Hub', 'mid', 15);

-- Enable realtime for flight_decisions
ALTER PUBLICATION supabase_realtime ADD TABLE public.flight_decisions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trajectory_updates;
ALTER PUBLICATION supabase_realtime ADD TABLE public.anomalies;