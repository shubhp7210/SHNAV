
-- Create flight_intents table to store all submitted flight plans
CREATE TABLE public.flight_intents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  aircraft_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  aircraft_type TEXT NOT NULL DEFAULT 'evtol',
  max_speed TEXT,
  max_altitude TEXT,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  altitude_band TEXT NOT NULL DEFAULT 'low',
  departure_window_start TEXT NOT NULL,
  departure_window_end TEXT NOT NULL,
  contingency_landing TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  conflicts INTEGER DEFAULT 0,
  trajectory_score INTEGER DEFAULT 0,
  weather_risk TEXT DEFAULT 'low',
  selected_clearance TEXT,
  authority_approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.flight_intents ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read flight intents (needed for conflict checking)
CREATE POLICY "Anyone can read flight intents"
ON public.flight_intents
FOR SELECT
USING (true);

-- Allow anyone to insert flight intents (no auth required for demo)
CREATE POLICY "Anyone can insert flight intents"
ON public.flight_intents
FOR INSERT
WITH CHECK (true);

-- Allow anyone to update their own flight intents
CREATE POLICY "Anyone can update flight intents"
ON public.flight_intents
FOR UPDATE
USING (true);
