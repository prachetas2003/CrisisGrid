/**
 * Open-Meteo live weather adapter (plan/06-data-strategy.md §4).
 * Keyless, free API. Used only when DEMO_MODE=false; always falls back to
 * scenario weather on timeout/error so the demo can never break on network.
 */

export interface LiveForecastPeriod {
  time: string;
  tempC: number;
  precipMmHr: number;
  windKmh: number;
  summary: string;
}

const WEATHER_CODES: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  80: "Rain showers", 81: "Heavy showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Severe thunderstorm",
};

export async function fetchOpenMeteoForecast(
  lat: number,
  lon: number,
  hours: number,
  timeoutMs = 2500,
): Promise<LiveForecastPeriod[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation,wind_speed_10m,weather_code&forecast_hours=${hours}&timezone=auto`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const body = (await res.json()) as {
      hourly: {
        time: string[];
        temperature_2m: number[];
        precipitation: number[];
        wind_speed_10m: number[];
        weather_code: number[];
      };
    };
    return body.hourly.time.map((t, i) => ({
      time: t,
      tempC: body.hourly.temperature_2m[i] ?? 0,
      precipMmHr: body.hourly.precipitation[i] ?? 0,
      windKmh: body.hourly.wind_speed_10m[i] ?? 0,
      summary: WEATHER_CODES[body.hourly.weather_code[i] ?? 0] ?? "Unknown",
    }));
  } finally {
    clearTimeout(timer);
  }
}

export function demoMode(): boolean {
  return (process.env.DEMO_MODE ?? "true").toLowerCase() !== "false";
}
