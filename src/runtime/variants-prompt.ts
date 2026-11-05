// Prompt de variantes de Stitch, armado por el cliente y no por un LLM: re-iteracion/stitch-ui/deob-2026-11-02/
// webcrack/DesignPage-s8oa9o80/deobfuscated.js (webcrack) :34432-34448 los aspectos (`fM`), :34449-34476 el prompt
// (`pM`). Correr N generaciones es del servidor de Stitch (el cliente solo manda variantCount, :34421) y no tiene
// extract: este módulo solo arma el texto.

export const VARIANT_ASPECTS = [
  { key: 'layout', label: 'Layout' },
  { key: 'colorScheme', label: 'Color scheme' },
  { key: 'images', label: 'Images' },
  { key: 'textFont', label: 'Text font' },
  { key: 'textContent', label: 'Text content' },
] as const;

export type VariantAspect = (typeof VARIANT_ASPECTS)[number]['key'];
export type CreativeRange = 'refine' | 'medium' | 'yolo';

export interface VariantsInput {
  variantCount?: number;
  creativeRange?: CreativeRange;
  aspects?: readonly VariantAspect[];
  customInstructions?: string;
}

export function variantsPrompt({ variantCount, creativeRange = 'medium', aspects = [], customInstructions = '' }: VariantsInput): string {
  const parts = [variantCount !== undefined && variantCount > 0 ? `Generate variants of this screen (create ${variantCount} ${variantCount === 1 ? 'variant' : 'variants'}).` : 'Generate variants of this screen.'];
  if (aspects.length > 0) {
    parts.push(`Focus on modifying the following aspects: ${aspects.map((k) => VARIANT_ASPECTS.find((a) => a.key === k)?.label ?? k).join(', ')}.`);
    const kept = VARIANT_ASPECTS.filter((a) => !aspects.includes(a.key)).map((a) => a.label);
    if (kept.length > 0) parts.push(`You MUST NOT modify the following aspects: ${kept.join(', ')}.`);
  }
  // `medium` no suma frase: en Stitch el switch solo tiene refine y yolo.
  if (creativeRange === 'refine') parts.push("The variations should be subtle refinements, closely adhering to the original design's structure and style.");
  if (creativeRange === 'yolo') parts.push("The variations should be radical, 'YOLO' explorations, fundamentally challenging the original design.");
  if (customInstructions.trim()) parts.push(`The primary instruction is: '${customInstructions.trim()}'.`);
  return parts.join(' ');
}
