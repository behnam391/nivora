pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        maven("https://redirector.gvt1.com/edgedl/android/maven2")
        // Restricted networks sometimes cannot reach Google Maven. These
        // fallbacks are limited to AndroidX artifacts and are never preferred.
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public") {
            content { includeGroupByRegex("androidx\\..*") }
        }
        maven("https://maven.aliyun.com/repository/google") {
            content { includeGroupByRegex("androidx\\..*") }
        }
        mavenCentral()
    }
}
rootProject.name = "NivoraAndroid"
include(":app")
include(":bankagent")
