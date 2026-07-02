export type TelemetryFrameV1 = {
  v: 1;
  t_ms: number;

  // Common / Tier 1
  alt_m?: number;
  vel_mps?: number;

  batt_v?: number;
  batt_pct?: number;
  current_a?: number; // battery current draw

  rssi_dbm?: number;
  snr_db?: number;    // radio link signal-to-noise

  // IMU (Tier 2)
  ax?: number; ay?: number; az?: number;
  gx?: number; gy?: number; gz?: number;

  // GPS (Tier 2)
  lat?: number;
  lon?: number;
  gps_fix?: number;
  gps_sats?: number;
  gps_alt_m?: number; // GPS altitude (MSL) — compare against baro alt_m (AGL)

  // Orientation (Tier 2)
  q_w?: number; q_x?: number; q_y?: number; q_z?: number;

  // Environment (Tier 2) — onboard baro/temp/humidity sensors
  temp_c?: number;
  pressure_pa?: number;
  humidity_pct?: number;

  // Events / pyro / states (Tier 3)
  event?: string;
  pyro_main_cont?: 0 | 1;
  pyro_drogue_cont?: 0 | 1;
};