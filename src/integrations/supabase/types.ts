export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      airspace_segments: {
        Row: {
          altitude_band: string
          capacity_per_hour: number
          created_at: string | null
          current_load: number
          id: string
          is_no_fly: boolean
          name: string
          no_fly_end: string | null
          no_fly_reason: string | null
          no_fly_start: string | null
          updated_at: string | null
        }
        Insert: {
          altitude_band?: string
          capacity_per_hour?: number
          created_at?: string | null
          current_load?: number
          id?: string
          is_no_fly?: boolean
          name: string
          no_fly_end?: string | null
          no_fly_reason?: string | null
          no_fly_start?: string | null
          updated_at?: string | null
        }
        Update: {
          altitude_band?: string
          capacity_per_hour?: number
          created_at?: string | null
          current_load?: number
          id?: string
          is_no_fly?: boolean
          name?: string
          no_fly_end?: string | null
          no_fly_reason?: string | null
          no_fly_start?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      anomalies: {
        Row: {
          aircraft_id: string
          anomaly_type: string
          description: string
          detected_at: string | null
          flight_intent_id: string | null
          id: string
          is_active: boolean | null
          lat: number | null
          lon: number | null
          resolved_at: string | null
          severity: string
        }
        Insert: {
          aircraft_id: string
          anomaly_type: string
          description: string
          detected_at?: string | null
          flight_intent_id?: string | null
          id?: string
          is_active?: boolean | null
          lat?: number | null
          lon?: number | null
          resolved_at?: string | null
          severity?: string
        }
        Update: {
          aircraft_id?: string
          anomaly_type?: string
          description?: string
          detected_at?: string | null
          flight_intent_id?: string | null
          id?: string
          is_active?: boolean | null
          lat?: number | null
          lon?: number | null
          resolved_at?: string | null
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "anomalies_flight_intent_id_fkey"
            columns: ["flight_intent_id"]
            isOneToOne: false
            referencedRelation: "flight_intents"
            referencedColumns: ["id"]
          },
        ]
      }
      flight_decisions: {
        Row: {
          aircraft_id: string
          airspace_load: number | null
          confidence: number
          created_at: string | null
          decision: string
          delay_minutes: number | null
          departure_time: string | null
          flight_intent_id: string | null
          id: string
          reason: string
          route_id: string | null
          simulation_result: Json | null
          weather_risk: string | null
        }
        Insert: {
          aircraft_id: string
          airspace_load?: number | null
          confidence?: number
          created_at?: string | null
          decision: string
          delay_minutes?: number | null
          departure_time?: string | null
          flight_intent_id?: string | null
          id?: string
          reason: string
          route_id?: string | null
          simulation_result?: Json | null
          weather_risk?: string | null
        }
        Update: {
          aircraft_id?: string
          airspace_load?: number | null
          confidence?: number
          created_at?: string | null
          decision?: string
          delay_minutes?: number | null
          departure_time?: string | null
          flight_intent_id?: string | null
          id?: string
          reason?: string
          route_id?: string | null
          simulation_result?: Json | null
          weather_risk?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flight_decisions_flight_intent_id_fkey"
            columns: ["flight_intent_id"]
            isOneToOne: false
            referencedRelation: "flight_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flight_decisions_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
        ]
      }
      flight_intents: {
        Row: {
          aircraft_id: string
          aircraft_type: string
          altitude_band: string
          archived_at: string | null
          authority_approved: boolean | null
          conflicts: number | null
          contingency_landing: string | null
          created_at: string
          departure_window_end: string
          departure_window_start: string
          destination: string
          id: string
          landed_at: string | null
          max_altitude: string | null
          max_speed: string | null
          operator_name: string
          origin: string
          scheduled_departure: string | null
          selected_clearance: string | null
          status: string
          trajectory_score: number | null
          updated_at: string
          user_id: string | null
          weather_risk: string | null
        }
        Insert: {
          aircraft_id: string
          aircraft_type?: string
          altitude_band?: string
          archived_at?: string | null
          authority_approved?: boolean | null
          conflicts?: number | null
          contingency_landing?: string | null
          created_at?: string
          departure_window_end: string
          departure_window_start: string
          destination: string
          id?: string
          landed_at?: string | null
          max_altitude?: string | null
          max_speed?: string | null
          operator_name: string
          origin: string
          scheduled_departure?: string | null
          selected_clearance?: string | null
          status?: string
          trajectory_score?: number | null
          updated_at?: string
          user_id?: string | null
          weather_risk?: string | null
        }
        Update: {
          aircraft_id?: string
          aircraft_type?: string
          altitude_band?: string
          archived_at?: string | null
          authority_approved?: boolean | null
          conflicts?: number | null
          contingency_landing?: string | null
          created_at?: string
          departure_window_end?: string
          departure_window_start?: string
          destination?: string
          id?: string
          landed_at?: string | null
          max_altitude?: string | null
          max_speed?: string | null
          operator_name?: string
          origin?: string
          scheduled_departure?: string | null
          selected_clearance?: string | null
          status?: string
          trajectory_score?: number | null
          updated_at?: string
          user_id?: string | null
          weather_risk?: string | null
        }
        Relationships: []
      }
      historical_flights: {
        Row: {
          aircraft_id: string
          archived_at: string
          conflicts: number | null
          created_at: string
          departure_window_end: string | null
          departure_window_start: string | null
          destination: string
          final_status: string
          flight_intent_id: string
          id: string
          landed_at: string | null
          operator_name: string
          origin: string
          scheduled_departure: string | null
          selected_clearance: string | null
          trajectory_score: number | null
          user_id: string | null
          weather_risk: string | null
        }
        Insert: {
          aircraft_id: string
          archived_at?: string
          conflicts?: number | null
          created_at?: string
          departure_window_end?: string | null
          departure_window_start?: string | null
          destination: string
          final_status?: string
          flight_intent_id: string
          id?: string
          landed_at?: string | null
          operator_name: string
          origin: string
          scheduled_departure?: string | null
          selected_clearance?: string | null
          trajectory_score?: number | null
          user_id?: string | null
          weather_risk?: string | null
        }
        Update: {
          aircraft_id?: string
          archived_at?: string
          conflicts?: number | null
          created_at?: string
          departure_window_end?: string | null
          departure_window_start?: string | null
          destination?: string
          final_status?: string
          flight_intent_id?: string
          id?: string
          landed_at?: string | null
          operator_name?: string
          origin?: string
          scheduled_departure?: string | null
          selected_clearance?: string | null
          trajectory_score?: number | null
          user_id?: string | null
          weather_risk?: string | null
        }
        Relationships: []
      }
      route_patterns: {
        Row: {
          altitude_band: string
          avg_efficiency_score: number | null
          avg_overall_score: number | null
          avg_safety_score: number | null
          avg_traffic_score: number | null
          avg_weather_score: number | null
          destination_key: string
          flight_count: number | null
          id: string
          last_updated: string | null
          origin_key: string
          preferred_waypoints: Json | null
        }
        Insert: {
          altitude_band: string
          avg_efficiency_score?: number | null
          avg_overall_score?: number | null
          avg_safety_score?: number | null
          avg_traffic_score?: number | null
          avg_weather_score?: number | null
          destination_key: string
          flight_count?: number | null
          id?: string
          last_updated?: string | null
          origin_key: string
          preferred_waypoints?: Json | null
        }
        Update: {
          altitude_band?: string
          avg_efficiency_score?: number | null
          avg_overall_score?: number | null
          avg_safety_score?: number | null
          avg_traffic_score?: number | null
          avg_weather_score?: number | null
          destination_key?: string
          flight_count?: number | null
          id?: string
          last_updated?: string | null
          origin_key?: string
          preferred_waypoints?: Json | null
        }
        Relationships: []
      }
      route_score_config: {
        Row: {
          id: string
          min_safe_separation_km: number | null
          updated_at: string | null
          weight_efficiency: number | null
          weight_safety: number | null
          weight_traffic: number | null
          weight_weather: number | null
        }
        Insert: {
          id?: string
          min_safe_separation_km?: number | null
          updated_at?: string | null
          weight_efficiency?: number | null
          weight_safety?: number | null
          weight_traffic?: number | null
          weight_weather?: number | null
        }
        Update: {
          id?: string
          min_safe_separation_km?: number | null
          updated_at?: string | null
          weight_efficiency?: number | null
          weight_safety?: number | null
          weight_traffic?: number | null
          weight_weather?: number | null
        }
        Relationships: []
      }
      routes: {
        Row: {
          aircraft_id: string
          alternate_routes: Json | null
          altitude_band: string
          conflict_details: Json | null
          created_at: string | null
          destination: string
          efficiency_score: number | null
          flight_intent_id: string | null
          id: string
          operator_name: string
          origin: string
          overall_score: number | null
          primary_route: Json | null
          safety_score: number | null
          selection_reason: string | null
          status: string | null
          traffic_score: number | null
          updated_at: string | null
          weather_conditions: Json | null
          weather_risk: string | null
          weather_score: number | null
        }
        Insert: {
          aircraft_id: string
          alternate_routes?: Json | null
          altitude_band: string
          conflict_details?: Json | null
          created_at?: string | null
          destination: string
          efficiency_score?: number | null
          flight_intent_id?: string | null
          id?: string
          operator_name: string
          origin: string
          overall_score?: number | null
          primary_route?: Json | null
          safety_score?: number | null
          selection_reason?: string | null
          status?: string | null
          traffic_score?: number | null
          updated_at?: string | null
          weather_conditions?: Json | null
          weather_risk?: string | null
          weather_score?: number | null
        }
        Update: {
          aircraft_id?: string
          alternate_routes?: Json | null
          altitude_band?: string
          conflict_details?: Json | null
          created_at?: string | null
          destination?: string
          efficiency_score?: number | null
          flight_intent_id?: string | null
          id?: string
          operator_name?: string
          origin?: string
          overall_score?: number | null
          primary_route?: Json | null
          safety_score?: number | null
          selection_reason?: string | null
          status?: string | null
          traffic_score?: number | null
          updated_at?: string | null
          weather_conditions?: Json | null
          weather_risk?: string | null
          weather_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "routes_flight_intent_id_fkey"
            columns: ["flight_intent_id"]
            isOneToOne: false
            referencedRelation: "flight_intents"
            referencedColumns: ["id"]
          },
        ]
      }
      time_slots: {
        Row: {
          aircraft_id: string
          created_at: string | null
          flight_intent_id: string | null
          id: string
          priority: number
          segment_id: string | null
          slot_end: string
          slot_start: string
          status: string
        }
        Insert: {
          aircraft_id: string
          created_at?: string | null
          flight_intent_id?: string | null
          id?: string
          priority?: number
          segment_id?: string | null
          slot_end: string
          slot_start: string
          status?: string
        }
        Update: {
          aircraft_id?: string
          created_at?: string | null
          flight_intent_id?: string | null
          id?: string
          priority?: number
          segment_id?: string | null
          slot_end?: string
          slot_start?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_slots_flight_intent_id_fkey"
            columns: ["flight_intent_id"]
            isOneToOne: false
            referencedRelation: "flight_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_slots_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "airspace_segments"
            referencedColumns: ["id"]
          },
        ]
      }
      trajectory_updates: {
        Row: {
          aircraft_id: string
          altitude_ft: number
          battery_pct: number | null
          deviation_meters: number | null
          flight_intent_id: string | null
          heading_deg: number | null
          id: string
          is_on_route: boolean | null
          lat: number
          lon: number
          recorded_at: string | null
          speed_kmh: number
        }
        Insert: {
          aircraft_id: string
          altitude_ft?: number
          battery_pct?: number | null
          deviation_meters?: number | null
          flight_intent_id?: string | null
          heading_deg?: number | null
          id?: string
          is_on_route?: boolean | null
          lat: number
          lon: number
          recorded_at?: string | null
          speed_kmh?: number
        }
        Update: {
          aircraft_id?: string
          altitude_ft?: number
          battery_pct?: number | null
          deviation_meters?: number | null
          flight_intent_id?: string | null
          heading_deg?: number | null
          id?: string
          is_on_route?: boolean | null
          lat?: number
          lon?: number
          recorded_at?: string | null
          speed_kmh?: number
        }
        Relationships: [
          {
            foreignKeyName: "trajectory_updates_flight_intent_id_fkey"
            columns: ["flight_intent_id"]
            isOneToOne: false
            referencedRelation: "flight_intents"
            referencedColumns: ["id"]
          },
        ]
      }
      vertiport_slots: {
        Row: {
          aircraft_id: string
          created_at: string | null
          delay_minutes: number | null
          flight_intent_id: string | null
          id: string
          scheduled_time: string
          slot_type: string
          status: string
          vertiport_id: string | null
        }
        Insert: {
          aircraft_id: string
          created_at?: string | null
          delay_minutes?: number | null
          flight_intent_id?: string | null
          id?: string
          scheduled_time: string
          slot_type: string
          status?: string
          vertiport_id?: string | null
        }
        Update: {
          aircraft_id?: string
          created_at?: string | null
          delay_minutes?: number | null
          flight_intent_id?: string | null
          id?: string
          scheduled_time?: string
          slot_type?: string
          status?: string
          vertiport_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vertiport_slots_flight_intent_id_fkey"
            columns: ["flight_intent_id"]
            isOneToOne: false
            referencedRelation: "flight_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vertiport_slots_vertiport_id_fkey"
            columns: ["vertiport_id"]
            isOneToOne: false
            referencedRelation: "vertiports"
            referencedColumns: ["id"]
          },
        ]
      }
      vertiports: {
        Row: {
          city: string | null
          created_at: string | null
          id: string
          is_active: boolean
          lat: number
          lon: number
          max_arrivals_per_hour: number
          max_departures_per_hour: number
          name: string
          pad_count: number
          updated_at: string | null
        }
        Insert: {
          city?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean
          lat?: number
          lon?: number
          max_arrivals_per_hour?: number
          max_departures_per_hour?: number
          name: string
          pad_count?: number
          updated_at?: string | null
        }
        Update: {
          city?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean
          lat?: number
          lon?: number
          max_arrivals_per_hour?: number
          max_departures_per_hour?: number
          name?: string
          pad_count?: number
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
