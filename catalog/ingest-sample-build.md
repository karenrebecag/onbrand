Un item por rol y librería, construido con vite en una copia del scaffold (/var/folders/js/qbhmlm1d5jl8xqv83ncpf_hw0000gn/T/wt-ingest-sample); nada se vendorizó en el repo. 13/13 builds verdes.
Arc: fetch real desde el vault + build. Relume: transformer sobre el source leído del vault + build; el codemod porta @kit/ui -> component Arc y react-icons -> lucide/brand, así que el build valida CSS module, JSX reescrito y el mapeo resuelto contra el scaffold. Los deps que el scaffold no instala quedan como TODO.

| rol | library | slug | gate | build | detalle |
| --- | --- | --- | --- | --- | --- |
| features | arc | comparison-table | ok | ok | vite build ok |
| pricing | arc | pricing-calculator | ok | ok | vite build ok |
| hero | relume | section_header10 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-4; imports marcados (0): - |
| features | relume | section_layout1 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-5; imports marcados (0): - |
| cta | relume | section_cta1 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-5; imports marcados (0): - |
| testimonials | relume | section_testimonial1 | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| pricing | relume | section_pricing1 | ok | ok | vite build ok; sin resolver por Tailwind (1): rb-5; imports marcados (0): - |
| faq | relume | section_faq12 | ok | ok | vite build ok; sin resolver por Tailwind (2): rb-12, rb-5; imports marcados (0): - |
| logos | relume | section_logo2 | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| stats | relume | section_stats1 | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| navbar | relume | navbar1_component | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| footer | relume | footer10_component | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
| banner | relume | banner1_component | ok | ok | vite build ok; sin resolver por Tailwind (0): -; imports marcados (0): - |
