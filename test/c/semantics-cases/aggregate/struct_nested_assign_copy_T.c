/*
 * evaluation information start
 * real case = true
 * evaluation item = 嵌套结构体复制
 * scene introduction = 嵌套成员逐个赋值后整体复制：副本保留内层污点
 * bind_url = c_semantics/aggregate/struct_nested_assign_copy_T
 * evaluation information end
 */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
char *taint_src(void);
void taint_sink(const char *s);
struct In { char *p; };
struct Out { struct In in; char *other; };

void struct_nested_assign_copy_T(void) {
    struct Out a;
    a.in.p = taint_src();
    a.other = "x";
    struct Out b = a;
    a.in.p = "safe";
    taint_sink(b.in.p);
}
