// Claude's markdown (lib/markdown) as React: in the chat, and for a feature's summary in the Keep dialog.
import { cn } from 'cn'
import { SmartLink } from '@/components/controls/ArtifactLink'
import { parseMarkdown, type Inline as InlinePart } from '@/lib/markdown'

const Parts = ({ parts }: { parts: InlinePart[] }) => (
  <>
    {parts.map((part, i) =>
      part.kind === 'link' ? (
        <SmartLink key={i} href={part.href} className={cn('text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-current dark:text-sky-400 dark:decoration-sky-400/30', part.code && 'rounded bg-muted px-1 font-mono text-[0.85em]')}>
          {part.text}
        </SmartLink>
      ) : part.kind === 'code' ? (
        <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em]">
          {part.text}
        </code>
      ) : part.kind === 'bold' ? (
        <b key={i}>{part.text}</b>
      ) : (
        part.text
      )
    )}
  </>
)

export const Markdown = ({ text }: { text: string }) => (
  <>
    {parseMarkdown(text).map((block, i) =>
      block.kind === 'code' ? (
        <pre key={i} className="my-1 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {block.text}
        </pre>
      ) : block.kind === 'table' ? (
        <div key={i} className="my-1 overflow-x-auto whitespace-normal">
          <table className="text-xs">
            <thead>
              <tr>
                {block.head.map((cell, j) => (
                  <th key={j} className="border px-2 py-1 text-left font-medium">
                    <Parts parts={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell, k) => (
                    <td key={k} className="border px-2 py-1 align-top">
                      <Parts parts={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : block.kind === 'list' ? (
        block.ordered ? (
          <ol key={i} className="my-1 list-decimal space-y-0.5 pl-5 whitespace-normal">
            {block.items.map((item, j) => (
              <li key={j}>
                <Parts parts={item} />
              </li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="my-1 list-disc space-y-0.5 pl-5 whitespace-normal">
            {block.items.map((item, j) => (
              <li key={j}>
                <Parts parts={item} />
              </li>
            ))}
          </ul>
        )
      ) : (
        <Parts key={i} parts={block.parts} />
      )
    )}
  </>
)

