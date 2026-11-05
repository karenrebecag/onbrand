import { expect, test } from 'bun:test';
import { variantsPrompt } from '../src/runtime/variants-prompt';

test('prompt de variantes: cantidad, aspectos a cambiar, MUST NOT del resto, rango e instrucción, como Stitch', () => {
  expect(variantsPrompt({ variantCount: 3, aspects: ['layout', 'colorScheme'], creativeRange: 'refine', customInstructions: '  más aire  ' })).toBe(
    "Generate variants of this screen (create 3 variants). Focus on modifying the following aspects: Layout, Color scheme. You MUST NOT modify the following aspects: Images, Text font, Text content. The variations should be subtle refinements, closely adhering to the original design's structure and style. The primary instruction is: 'más aire'.",
  );
  expect(variantsPrompt({ variantCount: 1, creativeRange: 'yolo' })).toBe("Generate variants of this screen (create 1 variant). The variations should be radical, 'YOLO' explorations, fundamentally challenging the original design.");
  expect(variantsPrompt({})).toBe('Generate variants of this screen.');
});
