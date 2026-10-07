场地划分为以下区域：
{{#map.zones}}
- {{name}}[{{id}}]
{{/map.zones}}
区域之间的关系：
{{#map.edges}}
- {{a}}与{{b}}：{{#adjacent}}相邻，一回合可走过去{{/adjacent}}{{^adjacent}}不相邻{{/adjacent}}；{{#visible}}互相看得见{{/visible}}{{^visible}}互相看不见{{/visible}}
{{/map.edges}}
{{#hasExits}}出口：{{#map.exits}}{{.}}；{{/map.exits}}
{{/hasExits}}
没有列出的两个区域之间既不相邻，也互相看不见。
