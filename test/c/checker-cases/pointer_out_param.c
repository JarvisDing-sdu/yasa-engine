#include <stdlib.h>
#include <string.h>

/* 输出参数：污点经指针写回调用者，再经 strcpy 拷贝到缓冲区 */
static void read_cmd(char **out) {
    *out = getenv("CMD");
}

void pointer_out_param(void) {
    char *cmd = "ls";
    char buf[128];
    read_cmd(&cmd);
    strcpy(buf, cmd);
    system(buf);
}
