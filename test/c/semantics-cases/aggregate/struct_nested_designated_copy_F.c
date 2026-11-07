/*
 * evaluation information start
 * real case = true
 * evaluation item = 嵌套结构体复制
 * scene introduction = 嵌套 struct 复制后覆盖副本的内层字段：副本不再带污点
 * bind_url = c_semantics/aggregate/struct_nested_designated_copy_F
 * evaluation information end
 */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
char *taint_src(void);
void taint_sink(const char *s);
struct In { char *p; };
struct Out { struct In in; char *other; };

void struct_nested_designated_copy_F(void) {
    struct Out a = { .in = { .p = taint_src() }, .other = "x" };
    struct Out b = a;
    b.in.p = "safe";
    taint_sink(b.in.p);
}
