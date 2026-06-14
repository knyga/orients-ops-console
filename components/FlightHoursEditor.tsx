"use client";

import { useRef } from "react";
import type { FlightHoursRow } from "@/lib/flightHours";
import { parseFlightHoursCsv } from "@/lib/flightHours";

interface Props {
  rows: FlightHoursRow[];
  onChange: (rows: FlightHoursRow[]) => void;
  /** Monotonic counter the parent owns, so new rows get stable unique ids. */
  nextId: () => string;
}

/**
 * Ephemeral flight-hours input: manual editable rows plus CSV upload
 * (columns: date,flight_hours). Nothing here is persisted.
 */
export function FlightHoursEditor({ rows, onChange, nextId }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const updateRow = (id: string, patch: Partial<FlightHoursRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addRow = () =>
    onChange([...rows, { id: nextId(), date: "", hours: "" }]);

  const removeRow = (id: string) => onChange(rows.filter((r) => r.id !== id));

  const handleFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseFlightHoursCsv(text, nextId());
    // Replace existing rows with the uploaded set.
    onChange(parsed.length ? parsed : rows);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Flight hours{" "}
          <span className="font-normal text-slate-400">(ephemeral)</span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            + Row
          </button>
          <label className="cursor-pointer rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
            Upload CSV
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </label>
        </div>
      </div>

      <p className="mb-3 text-xs text-slate-400">
        CSV columns: <code className="text-slate-500">date,flight_hours</code>{" "}
        (e.g. <code className="text-slate-500">2026-04-01,2</code>).
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          No flight hours yet — add a row or upload a CSV.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <input
                type="date"
                value={row.date}
                onChange={(e) => updateRow(row.id, { date: e.target.value })}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
              />
              <input
                type="number"
                min="0"
                step="0.25"
                inputMode="decimal"
                placeholder="hours"
                value={row.hours}
                onChange={(e) => updateRow(row.id, { hours: e.target.value })}
                className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
              />
              <span className="text-xs text-slate-400">h</span>
              <button
                type="button"
                onClick={() => removeRow(row.id)}
                aria-label="Remove row"
                className="ml-auto rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
