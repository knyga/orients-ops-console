import Image from "next/image";
import type { VimeoVideo } from "@/lib/vimeo";
import { formatDateTime, secondsToMinutes } from "@/lib/format";

/** Per-video table: thumbnail, name, duration, upload time, description, link. */
export function VideoTable({ videos }: { videos: VimeoVideo[] }) {
  if (videos.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        No videos found for the selected period.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Thumb</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2 text-right">Min</th>
            <th className="px-3 py-2">Uploaded (Kyiv)</th>
            <th className="px-3 py-2">Description</th>
            <th className="px-3 py-2">Link</th>
          </tr>
        </thead>
        <tbody>
          {videos.map((video, i) => (
            <tr
              key={`${video.link}-${i}`}
              className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50"
            >
              <td className="px-3 py-2">
                {video.pictures?.base_link ? (
                  <Image
                    src={video.pictures.base_link}
                    alt=""
                    width={96}
                    height={54}
                    unoptimized
                    className="h-[54px] w-24 rounded object-cover"
                  />
                ) : (
                  <div className="h-[54px] w-24 rounded bg-slate-100" />
                )}
              </td>
              <td className="px-3 py-2 font-medium text-slate-900">
                {video.name}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {secondsToMinutes(video.duration)}
              </td>
              <td className="px-3 py-2 whitespace-nowrap tabular-nums text-slate-600">
                {formatDateTime(video.created_time)}
              </td>
              <td className="max-w-xs px-3 py-2 text-slate-500">
                <span className="line-clamp-2">{video.description ?? "—"}</span>
              </td>
              <td className="px-3 py-2">
                <a
                  href={video.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-sky-600 hover:text-sky-700 hover:underline"
                >
                  Open
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
