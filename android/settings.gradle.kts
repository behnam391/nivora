pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // Google Maven can be unreachable on some Iranian networks. This mirror is a fallback for pinned AndroidX artifacts.
        maven("https://maven.aliyun.com/repository/google") {
            content { includeGroupByRegex("androidx\\..*") }
        }
        maven("https://redirector.gvt1.com/edgedl/android/maven2")
        google()
        mavenCentral()
    }
}
rootProject.name = "NivoraAndroid"
include(":app")
