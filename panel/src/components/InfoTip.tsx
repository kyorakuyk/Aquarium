export function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <button className="info-tip" type="button" title={text} aria-label={label}>
      <span aria-hidden="true">ⓘ</span>
    </button>
  );
}
