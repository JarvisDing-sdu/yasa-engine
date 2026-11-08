extern "C" char *getenv(const char*);
extern "C" int system(const char*);
void good(){
system(R"cmd(echo safe)cmd");
}
